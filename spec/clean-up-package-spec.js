/*global describe, it, beforeEach, afterEach, expect*/
const underTest = require('../src/tasks/clean-up-package'),
	fs = require('fs'),
	fsUtil = require('../src/util/fs-util'),
	ArrayLogger = require('../src/util/array-logger'),
	tmppath = require('../src/util/tmppath'),
	runNpm = require('../src/util/run-npm'),
	path = require('path');
describe('cleanUpPackage', () => {
	'use strict';
	let sourcedir, pwd, logger;
	const configurePackage = function (packageConf) {
		packageConf.name = 'name1';
		packageConf.version = '1.0.0';
		packageConf.repository = '/';
		packageConf.license = 'UNLICENSED';
		fs.writeFileSync(path.join(sourcedir, 'package.json'), JSON.stringify(packageConf), 'utf8');
	};
	beforeEach(done => {
		sourcedir = tmppath();
		fs.mkdirSync(sourcedir);
		logger = new ArrayLogger();
		pwd = process.cwd();
		configurePackage({
			dependencies: {
				'uuid': '^2.0.0'
			},
			optionalDependencies: {
				'minimist': '^1.2.0'
			}
		});
		runNpm(sourcedir, ['install', '--silent'], logger, true)
		.then(done, done.fail);
	});
	afterEach(() => {
		process.chdir(pwd);
		if (sourcedir) {
			fsUtil.rmDir(sourcedir);
		}
	});
	it('returns the directory path', done => {
		underTest(sourcedir, {}, logger)
		.then(result => {
			expect(result).toEqual(sourcedir);
		})
		.then(done, done.fail);
	});
	it('does not clean up optional dependencies if not requested', done => {
		underTest(sourcedir, {}, logger)
		.then(result => {
			expect(result).toEqual(sourcedir);
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'uuid'))).toBeTruthy();
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'minimist'))).toBeTruthy();
		})
		.then(done, done.fail);
	});
	it('cleans up optional dependencies if requested', done => {
		underTest(sourcedir, { 'optional-dependencies': false }, logger)
		.then(result => {
			expect(result).toEqual(sourcedir);
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'uuid'))).toBeTruthy();
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'minimist'))).toBeFalsy();
		})
		.then(done, done.fail);
	});
	it('passes additional options to NPM if requested', done => {
		underTest(sourcedir, { 'optional-dependencies': false, 'npm-options': '--dry-run' }, logger)
		.then(result => {
			expect(result).toEqual(sourcedir);
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'uuid'))).toBeFalsy();
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'minimist'))).toBeFalsy();
		})
		.then(done, done.fail);
	});

	it('removes .npmrc if exists', done => {
		fs.writeFileSync(path.join(sourcedir, '.npmrc'), 'optional = false', 'utf8');
		underTest(sourcedir, {}, logger)
		.then(result => {
			expect(result).toEqual(sourcedir);
			expect(fsUtil.isFile(path.join(sourcedir, '.npmrc'))).toBeFalsy();
		})
		.then(done, done.fail);
	});
	it('removes package-lock.json if exists', done => {
		fs.writeFileSync(path.join(sourcedir, 'package-lock.json'), '{}', 'utf8');
		underTest(sourcedir, {}, logger)
		.then(result => {
			expect(result).toEqual(sourcedir);
			expect(fsUtil.isFile(path.join(sourcedir, 'package-lock.json'))).toBeFalsy();
		})
		.then(done, done.fail);
	});
	it('fails if npm install fails', done => {
		configurePackage({
			files: ['root.txt'],
			dependencies: {
				'non-existing-package': '2.0.0'
			}
		});
		underTest(sourcedir, { 'optional-dependencies': false }, logger)
		.then(done.fail, reason => {
			expect(reason).toMatch(/npm install -q --no-package-lock --no-audit --production --no-optional failed/);
			done();
		});
	});
	it('logs progress', done => {
		const logger = new ArrayLogger();
		underTest(sourcedir, { 'optional-dependencies': false, 'npm-options': '--dry-run' }, logger)
		.then(() => {
			expect(logger.getCombinedLog()).toEqual([
				['call', 'removing optional dependencies'],
				['call', 'npm install -q --no-package-lock --no-audit --production --no-optional --dry-run'],
				['call', 'npm dedupe -q --no-package-lock --production --no-optional --dry-run']
			]);
		})
		.then(done, done.fail);
	});
	it('only dedupes if optional deps are not turned off', done => {
		const logger = new ArrayLogger();
		underTest(sourcedir, {}, logger)
		.then(() => {
			expect(logger.getCombinedLog()).toEqual([
				['call', 'npm dedupe -q --no-package-lock']
			]);
		})
		.then(done, done.fail);
	});
	it('executes a post-package script if requested', done => {
		const logger = new ArrayLogger();
		configurePackage({
			files: ['root.txt'],
			scripts: {
				'customPack': 'npm uninstall uuid'
			}
		});
		underTest(sourcedir, {'post-package-script': 'customPack'}, logger)
		.then(() => {
			expect(fsUtil.isDir(path.join(sourcedir, 'node_modules', 'uuid'))).toBeFalsy();
			expect(logger.getCombinedLog()).toEqual([
				['call', 'npm dedupe -q --no-package-lock'],
				['call', 'npm run customPack']
			]);
		})
		.then(done, done.fail);
	});
	it('fixes file permissions for non-world readable files in the directory', done => {
		fs.writeFileSync(path.join(sourcedir, 'owner-readable.txt'), 'owner', 'utf8');
		fs.chmodSync(path.join(sourcedir, 'owner-readable.txt'), 0o400);
		fs.writeFileSync(path.join(sourcedir, 'group-readable.txt'), 'group', 'utf8');
		fs.chmodSync(path.join(sourcedir, 'group-readable.txt'), 0o640);
		fs.writeFileSync(path.join(sourcedir, 'group-executable.txt'), 'group-exec', 'utf8');
		fs.chmodSync(path.join(sourcedir, 'group-executable.txt'), 0o650);
		fs.mkdirSync(path.join(sourcedir, 'subdir'));
		fs.chmodSync(path.join(sourcedir, 'subdir'), 0o700);
		fs.writeFileSync(path.join(sourcedir, 'subdir', 'user-exec.txt'), 'user-exec', 'utf8');
		fs.chmodSync(path.join(sourcedir, 'subdir', 'user-exec.txt'), 0o701);
		underTest(sourcedir, { }, logger)
		.then(() => {
			expect(fs.statSync(path.join(sourcedir, 'owner-readable.txt')).mode & 0o777).toEqual(0o644);
			expect(fs.statSync(path.join(sourcedir, 'group-readable.txt')).mode & 0o777).toEqual(0o644);
			expect(fs.statSync(path.join(sourcedir, 'group-executable.txt')).mode & 0o777).toEqual(0o654);
			expect(fs.statSync(path.join(sourcedir, 'subdir')).mode & 0o777).toEqual(0o755);
			expect(fs.statSync(path.join(sourcedir, 'subdir', 'user-exec.txt')).mode & 0o777).toEqual(0o745);
		})
		.then(done, done.fail);

	});
});
