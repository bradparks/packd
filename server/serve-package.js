const path = require( 'path' );
const sander = require( 'sander' );
const semver = require( 'semver' );
const targz = require( 'tar.gz' );
const LRU = require( 'lru-cache' );
const zlib = require( 'zlib' );
const request = require( 'request' );
const child_process = require( 'child_process' );
const browserify = require( 'browserify' );
const rollup = require( 'rollup' );
const resolve = require( 'rollup-plugin-node-resolve' );
const UglifyJS = require( 'uglifyjs' );
const get = require( './utils/get.js' );
const makeLegalIdentifier = require( './utils/makeLegalIdentifier' );
const log = require( './log.js' );

const { root, tmpdir, registry } = require( '../config.js' );

const cache = LRU({
	max: 128 * 1024 * 1024,
	length: src => src.length
});

function stringify ( query ) {
	const str = Object.keys( query ).sort().map( key => `${key}=${query[key]}` ).join( '&' );
	return str ? `?${str}` : '';
}

module.exports = function servePackage ( req, res ) {
	const match = /^(?:@([^\/]+)\/)?([^@\/]+)(?:@(.+))?$/.exec( req.params.id );

	if ( !match ) {
		res.statusCode( 400 );
		res.end( 'Invalid module ID' );
		return;
	}

	const user = match[1];
	const id = match[2];
	const tag = match[3] || 'latest';

	const qualified = user ? `@${user}/${id}` : id;

	get( `${registry}/${encodeURIComponent( qualified )}` ).then( JSON.parse )
		.then( pkg => {
			if ( !pkg.versions ) {
				log.error( `[${qualified}] invalid module` );

				res.status( 400 );
				res.end( 'invalid module' );

				return;
			}

			if ( !semver.valid( tag ) ) {
				const version = pkg[ 'dist-tags' ][ tag ];
				if ( semver.valid( version ) ) {
					res.redirect( 302, `/bundle/${pkg.name}@${version}${stringify( req.query )}` );
				} else {
					log.error( `[${qualified}] invalid tag` );

					res.status( 400 );
					res.end( 'invalid tag' );
				}

				return;
			}

			return fetchBundle( pkg, tag, req.query ).then( zipped => {
				log.info( `[${qualified}] serving ${zipped.length} bytes` );
				res.status( 200 );
				res.set({
					'Content-Length': zipped.length,
					'Content-Type': 'application/javascript',
					'Content-Encoding': 'gzip',
					'Cache-Control': 'max-age=86400'
				});
				res.end( zipped );
			});
		})
		.catch( err => {
			log.error( `[${qualified}] ${err.message}` );
			res.status( 500 );
			res.end( sander.readFileSync( `${root}/server/templates/500.html`, { encoding: 'utf-8' }) );
		});
};

const inProgress = {};

function fetchBundle ( pkg, version, query ) {
	const hash = `${pkg.name}@${version}${stringify(query)}`;

	log.info( `[${pkg.name}] requested package` );

	if ( cache.has( hash ) ) {
		log.info( `[${pkg.name}] is cached` );
		return Promise.resolve( cache.get( hash ) );
	}

	if ( inProgress[ hash ] ) {
		log.info( `[${pkg.name}] request was already in progress` );
	} else {
		log.info( `[${pkg.name}] is not cached` );

		const dir = `${tmpdir}/${hash}`;
		const cwd = `${dir}/package`;

		function cleanup () {
			inProgress[ hash ] = null;
			sander.rimraf( dir ); // not returning this, no need to wait
		}

		inProgress[ hash ] = sander.mkdir( dir )
			.then( () => fetchAndExtract( pkg, version, dir ) )
			.then( () => sanitizePkg( cwd ) )
			.then( () => installDependencies( cwd ) )
			.then( () => bundle( cwd, query ) )
			.then( code => {
				log.info( `[${pkg.name}] minifying` );

				let zipped;

				try {
					const minified = UglifyJS.minify( code, { fromString: true }).code;
					zipped = zlib.gzipSync( minified );
				} catch ( err ) {
					log.info( `[${pkg.name}] minification failed: ${err.message}` );
					zipped = zlib.gzipSync( code );
				}

				cache.set( hash, zipped );

				cleanup();
				return zipped;
			})
			.catch( err => {
				cleanup();
				throw err;
			});
	}

	return inProgress[ hash ];
}

function fetchAndExtract ( pkg, version, dir ) {
	const tarUrl = pkg.versions[ version ].dist.tarball;

	log.info( `[${pkg.name}] fetching ${tarUrl}` );

	return new Promise( ( fulfil, reject ) => {
		let timedout = false;

		const timeout = setTimeout( () => {
			reject( new Error( 'Request timed out' ) );
			timedout = true;
		}, 10000 );

		const input = request( tarUrl );

		// don't like going via the filesystem, but piping into targz
		// was failing for some weird reason
		const intermediate = sander.createWriteStream( `${dir}/package.tgz` );

		input.pipe( intermediate );

		intermediate.on( 'close', () => {
			clearTimeout( timeout );

			if ( !timedout ) {
				targz().extract( `${dir}/package.tgz`, dir ).then( fulfil, reject );
			}
		});
	});
}

function sanitizePkg ( cwd ) {
	const pkg = require( `${cwd}/package.json` );
	pkg.scripts = {};
	return sander.writeFile( `${cwd}/package.json`, JSON.stringify( pkg, null, '  ' ) );
}

function exec ( cmd, cwd ) {
	return new Promise( ( fulfil, reject ) => {
		child_process.exec( cmd, { cwd }, ( err, stdout, stderr ) => {
			if ( err ) {
				return reject( err );
			}

			console.log( stdout );
			console.error( stderr );

			fulfil();
		});
	});
}

function installDependencies ( cwd ) {
	const pkg = require( `${cwd}/package.json` );
	log.info( `[${pkg.name}] running yarn --production` );
	console.log( `pkg`, pkg )
	return exec( `${root}/node_modules/.bin/yarn --production`, cwd ).then( () => {
		if ( !pkg.peerDependencies ) return;

		return Object.keys( pkg.peerDependencies ).reduce( ( promise, name ) => {
			return promise.then( () => {
				log.info( `[${pkg.name}] installing peer dependency ${name}` );
				const version = pkg.peerDependencies[ name ];
				return exec( `${root}/node_modules/.bin/yarn add ${name}@${version}`, cwd );
			});
		}, Promise.resolve() );
	});
}

function bundle ( cwd, query ) {
	const pkg = require( `${cwd}/package.json` );
	const moduleName = query.name || makeLegalIdentifier( pkg.name );

	const moduleEntry = pkg.module || pkg[ 'jsnext:main' ];

	if ( moduleEntry ) {
		log.info( `[${pkg.name}] ES2015 module found, using Rollup` );
		return bundleWithRollup( cwd, pkg, moduleEntry, moduleName );
	} else {
		log.info( `[${pkg.name}] No ES2015 module found, using Browserify` );
		const main = path.resolve( cwd, pkg.main || 'index.js' );
		return bundleWithBrowserify( pkg, main, moduleName );
	}
}

function bundleWithRollup ( cwd, pkg, moduleEntry, moduleName ) {
	return rollup.rollup({
		entry: path.resolve( cwd, moduleEntry ),
		plugins: [
			resolve({ module: true, jsnext: true, main: false })
		]
	}).then( bundle => {
		log.info( `[${pkg.name}] bundled using Rollup` );

		if ( bundle.imports.length > 0 ) {
			log.info( `[${pkg.name}] non-ES2015 dependencies found, handing off to Browserify` );

			const intermediate = `${cwd}/__intermediate.js`;
			return bundle.write({
				dest: intermediate,
				format: 'cjs'
			}).then( () => {
				return bundleWithBrowserify( pkg, intermediate, moduleName );
			});
		}

		else {
			return bundle.generate({
				format: 'umd',
				moduleName
			}).code;
		}
	});
}

function bundleWithBrowserify ( pkg, main, moduleName ) {
	const b = browserify( main, {
		standalone: moduleName
	});

	return new Promise( ( fulfil, reject ) => {
		b.bundle( ( err, buf ) => {
			if ( err ) {
				reject( err );
			} else {
				log.info( `[${pkg.name}] bundled using Browserify` );
				fulfil( '' + buf );
			}
		});
	});
}