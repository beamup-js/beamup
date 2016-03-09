/*global describe, require, it, expect, beforeEach, afterEach, console, jasmine */
var underTest = require('../src/commands/create'),
	tmppath = require('../src/util/tmppath'),
	callApi = require('../src/util/call-api'),
	templateFile = require('../src/util/template-file'),
	shell = require('shelljs'),
	fs = require('fs'),
	path = require('path'),
	aws = require('aws-sdk'),
	Promise = require('bluebird'),
	awsRegion = 'us-east-1';
describe('create', function () {
	'use strict';
	var workingdir, testRunName, iam, lambda, newObjects, config,logs,
		createFromDir = function (dir) {
			if (!shell.test('-e', workingdir)) {
				shell.mkdir('-p', workingdir);
			}
			shell.cp('-r', 'spec/test-projects/' + (dir || 'hello-world') + '/*', workingdir);
			return underTest(config).then(function (result) {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				newObjects.restApi = result.api && result.api.id;
				return result;
			});
		};

	beforeEach(function () {
		workingdir = tmppath();
		testRunName = 'test' + Date.now();
		iam = Promise.promisifyAll(new aws.IAM());
		lambda = Promise.promisifyAll(new aws.Lambda({region: awsRegion}), {suffix: 'Promise'});
		logs = new aws.CloudWatchLogs({region: awsRegion});
		newObjects = {workingdir: workingdir};
		jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;
		config = {name: testRunName, region: awsRegion, source: workingdir, handler: 'main.handler'};
	});
	afterEach(function (done) {
		this.destroyObjects(newObjects).catch(function (err) {
			console.log('error cleaning up', err);
		}).finally(done);
	});
	it('fails if name is not given', function (done) {
		config.name = undefined;
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('project name is missing. please specify with --name');
			done();
		});
	});
	it('fails if the region is not given', function (done) {
		config.region = undefined;
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('AWS region is missing. please specify with --region');
			done();
		});
	});
	it('fails if the handler is not given', function (done) {
		config.handler = undefined;
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('Lambda handler is missing. please specify with --handler');
			done();
		});
	});

	it('fails if claudia.json already exists in the source folder', function (done) {
		shell.mkdir(workingdir);
		fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('claudia.json already exists in the source folder');
			done();
		});
	});
	it('works if claudia.json already exists in the source folder but alternative config provided', function (done) {
		shell.mkdir(workingdir);
		shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
		fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
		shell.cd(workingdir);
		config.config = 'lambda.json';
		underTest(config).then(done, done.fail);
	});
	it('fails if the alternative config is provided but the file already exists', function (done) {
		shell.mkdir(workingdir);
		shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
		fs.writeFileSync(path.join(workingdir, 'lambda.json'), '{}', 'utf8');
		shell.cd(workingdir);
		config.config = 'lambda.json';
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('lambda.json already exists');
			done();
		});
	});
	it('checks the current folder if the source parameter is not defined', function (done) {
		shell.mkdir(workingdir);
		shell.cd(workingdir);
		fs.writeFileSync(path.join('claudia.json'), '{}', 'utf8');
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('claudia.json already exists in the source folder');
			done();
		});
	});
	it('fails if package.json does not exist in the target folder', function (done) {
		shell.mkdir(workingdir);
		shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
		shell.rm(path.join(workingdir, 'package.json'));
		underTest(config).then(done.fail, function (message) {
			expect(message).toEqual('package.json does not exist in the source folder');
			done();
		});
	});
	describe('role management', function () {
		it('creates the IAM role for the lambda', function (done) {
			createFromDir('hello-world').then(function () {
				return iam.getRoleAsync({RoleName: testRunName + '-executor'});
			}).then(function (role) {
				expect(role.Role.RoleName).toEqual(testRunName + '-executor');
			}).then(done, done.fail);
		});
		it('does not create a role if the role option is provided, uses the provided one instead', function (done) {
			var createdRole;

			return fs.readFileAsync(templateFile('lambda-exector-policy.json'), 'utf8')
			.then(function (lambdaRolePolicy) {
				return iam.createRoleAsync({
					RoleName: testRunName + '-manual',
					AssumeRolePolicyDocument: lambdaRolePolicy
				});
			}).then(function (result) {
				createdRole = result.Role;
				config.role = testRunName + '-manual';
				return createFromDir('hello-world');
			}).then(function (createResult) {
				expect(createResult.lambda.role).toEqual(testRunName + '-manual');
			}).then(function () {
				return lambda.getFunctionConfigurationPromise({FunctionName: testRunName});
			}).then(function (lambdaMetadata) {
				expect(lambdaMetadata.Role).toEqual(createdRole.Arn);
			}).then(function () {
				return iam.getRoleAsync({RoleName: testRunName + '-executor'});
			}).then(function () {
					done.fail('Executor role was created');
				},
				done);
		});
		it('allows the function to log to cloudwatch', function (done) {
			var createLogGroup = Promise.promisify(logs.createLogGroup.bind(logs)),
				createLogStream = Promise.promisify(logs.createLogStream.bind(logs)),
				getLogEvents = Promise.promisify(logs.getLogEvents.bind(logs));
			createLogGroup({logGroupName: testRunName + '-group'}).then(function () {
				newObjects.logGroup = testRunName + '-group';
				return createLogStream({logGroupName: testRunName + '-group', logStreamName: testRunName + '-stream'});
			}).then(function () {
				return createFromDir('cloudwatch-log');
			}).then(function () {
				return lambda.invokePromise({
					FunctionName: testRunName,
					Payload: JSON.stringify({
						region: awsRegion,
						stream: testRunName + '-stream',
						group: testRunName + '-group',
						message: 'hello ' + testRunName
					})
				});
			}).then(function () {
				return getLogEvents({logGroupName: testRunName + '-group', logStreamName: testRunName + '-stream'});
			}).then(function (logEvents) {
				expect(logEvents.events.length).toEqual(1);
				expect(logEvents.events[0].message).toEqual('hello ' + testRunName);
			}).then(done, done.fail);
		});
		it('loads additional policies from a policies directory recursively, if provided', function (done) {
			var sesPolicy = {
					'Version': '2012-10-17',
					'Statement': [{
						'Effect': 'Allow',
						'Action': [
							'ses:SendEmail'
						],
						'Resource': ['*']
					}]
				},
				policiesDir = path.join(workingdir, 'policies');
			shell.mkdir('-p', path.join(policiesDir, 'subdir'));
			fs.writeFileSync(path.join(workingdir, 'policies', 'subdir', 'ses policy.json'), JSON.stringify(sesPolicy), 'utf8');
			config.policies = policiesDir;
			createFromDir('hello-world').then(function () {
				return iam.listRolePoliciesAsync({RoleName: testRunName + '-executor'});
			}).then(function (result) {
				expect(result.PolicyNames).toEqual(['log-writer', 'ses-policy-json']);
			}).then(function () {
				return iam.getRolePolicyAsync({PolicyName: 'ses-policy-json', RoleName:  testRunName + '-executor'});
			}).then(function (policy) {
				expect(JSON.parse(decodeURIComponent(policy.PolicyDocument))).toEqual(sesPolicy);
			}).then(done, done.fail);
		});
		it('loads additional policies from a file pattern, if provided', function (done) {
			var sesPolicy = {
					'Version': '2012-10-17',
					'Statement': [{
						'Effect': 'Allow',
						'Action': [
							'ses:SendEmail'
						],
						'Resource': ['*']
					}]
				},
				policiesDir = path.join(workingdir, 'policies');
			shell.mkdir('-p', path.join(policiesDir));
			fs.writeFileSync(path.join(workingdir, 'policies', 'ses policy.json'), JSON.stringify(sesPolicy), 'utf8');
			config.policies = path.join(policiesDir, '*.json');
			createFromDir('hello-world').then(function () {
				return iam.listRolePoliciesAsync({RoleName: testRunName + '-executor'});
			}).then(function (result) {
				expect(result.PolicyNames).toEqual(['log-writer', 'ses-policy-json']);
			}).then(function () {
				return iam.getRolePolicyAsync({PolicyName: 'ses-policy-json', RoleName:  testRunName + '-executor'});
			}).then(function (policy) {
				expect(JSON.parse(decodeURIComponent(policy.PolicyDocument))).toEqual(sesPolicy);
			}).then(done, done.fail);
		});
		it('fails if the policies argument does not match any files', function (done) {
			config.policies = path.join('*.NOT');
			createFromDir('hello-world').then(done.fail, function (error) {
				expect(error).toEqual('no files match additional policies (*.NOT)');
				done();
			});
		});


	});
	describe('creating the function', function () {
		it('returns an object containing the new claudia configuration', function (done) {
			createFromDir('hello-world').then(function (creationResult) {
				expect(creationResult.lambda).toEqual({
					role: testRunName + '-executor',
					region: awsRegion,
					name: testRunName
				});
				return '';
			}).then(done, done.fail);
		});
		it('saves the configuration into claudia.json', function (done) {
			createFromDir('hello-world').then(function (creationResult) {
				expect(JSON.parse(fs.readFileSync(path.join(workingdir, 'claudia.json'), 'utf8'))).toEqual(creationResult);
			}).then(done, done.fail);
		});
		it('saves the configuration into an alternative configuration file if provided', function (done) {
			config.config = path.join(workingdir, 'lambda.json');
			createFromDir('hello-world').then(function (creationResult) {
				expect(shell.test('-e', path.join(workingdir, 'claudia.json'))).toBeFalsy();
				expect(JSON.parse(fs.readFileSync(path.join(workingdir, 'lambda.json'), 'utf8'))).toEqual(creationResult);
			}).then(done, done.fail);
		});
		it('configures the function in AWS so it can be invoked', function (done) {
			createFromDir('hello-world').then(function () {
				return lambda.invokePromise({FunctionName: testRunName});
			}).then(function (lambdaResult) {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello world"');
			}).then(done, done.fail);
		});
		it('configures the function so it will be versioned', function (done) {
			createFromDir('hello-world').then(function () {
				return lambda.listVersionsByFunctionPromise({FunctionName: testRunName});
			}).then(function (result) {
				expect(result.Versions.length).toEqual(2);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
			}).then(done, done.fail);
		});
		it('adds the latest alias', function (done) {
			config.version = 'great';
			createFromDir('hello-world').then(function () {
				return lambda.getAliasPromise({FunctionName: testRunName, Name: 'latest'});
			}).then(function (result) {
				expect(result.FunctionVersion).toEqual('$LATEST');
			}).then(done, done.fail);
		});
		it('adds the version alias if supplied', function (done) {
			config.version = 'great';
			createFromDir('hello-world').then(function () {
				return lambda.getAliasPromise({FunctionName: testRunName, Name: 'great'});
			}).then(function (result) {
				expect(result.FunctionVersion).toEqual('1');
			}).then(done, done.fail);
		});
	});
	describe('creating the web api', function () {
		var apiGateway = Promise.promisifyAll(new aws.APIGateway({region: awsRegion})), apiId;
		beforeEach(function () {
			config.handler = undefined;
			config['api-module'] = 'main';
		});		
		it('fails if no APIConfig is found on the module', function(done) {
			createFromDir('api-gw-no-export').then(done.fail, function (error) {
				console.log(error);
				expect(error).toEqual('No apiConfig defined on module \'main\'. Are you missing an module.exports?');
				done();
			});
		});
		it('ignores the handler but creates an API if the api-module is provided', function (done) {
			createFromDir('api-gw-hello-world').then(function (creationResult) {
				var apiId = creationResult.api && creationResult.api.id;
				newObjects.restApi = apiId;
				expect(apiId).toBeTruthy();
				expect(creationResult.api.module).toEqual('main');
				expect(JSON.parse(fs.readFileSync(path.join(workingdir, 'claudia.json'), 'utf8')))
					.toEqual(creationResult);
				return apiId;
			}).then(function (apiId) {
				return apiGateway.getRestApiAsync({restApiId: apiId});
			}).then(function (restApi) {
				expect(restApi.name).toEqual(testRunName);
			}).then(done, done.fail);
		});
		it('when no version provided, creates the latest deployment', function (done) {
			createFromDir('api-gw-hello-world').then(function (creationResult) {
				apiId = creationResult.api && creationResult.api.id;
			}).then(function () {
				return callApi(apiId, awsRegion, 'latest/hello');
			}).then(function (contents) {
				expect(contents.body).toEqual('"hello world"');
			}).then(done, done.fail);
		});
		it('when the version is provided, creates the deployment with that name', function (done) {
			config.version = 'development';
			createFromDir('api-gw-hello-world').then(function (creationResult) {
				apiId = creationResult.api && creationResult.api.id;
			}).then(function () {
				return callApi(apiId, awsRegion, 'development/hello');
			}).then(function (contents) {
				expect(contents.body).toEqual('"hello world"');
			}).then(done, done.fail);
		});
		it('makes it possible to deploy a custom stage, as long as the lambdaVersion is defined', function (done) {
			config.version = 'development';
			createFromDir('api-gw-hello-world').then(function (creationResult) {
				apiId = creationResult.api && creationResult.api.id;
				return apiGateway.createDeploymentAsync({
					restApiId: apiId,
					stageName: 'fromtest',
					variables: {
						lambdaVersion: 'development'
					}
				});
			}).then(function () {
				return callApi(apiId, awsRegion, 'fromtest/hello');
			}).then(function (contents) {
				expect(contents.body).toEqual('"hello world"');
			}).then(done, done.fail);
		});
	});
});
