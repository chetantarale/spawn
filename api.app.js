'use strict';

process.title = 'shippable.api';
module.exports = init;
// To allow the Shippable adapter to make more than five calls at a time:
require('http').globalAgent.maxSockets = 10000;

require('./common/logger.js');
require('./common/ActErr.js');
require('./common/mapSequelizeErr.js');
require('./common/safeGet.js');
require('./common/express/sendJSONResponse.js');
require('./common/express/sendXMLResponse.js');
require('./common/respondWithError.js');

var glob = require('glob');
var async = require('async');
var _ = require('underscore');
var express = require('express');
var ignoreEADDRINUSE = false;
var Sequelize = require('sequelize');
//bigint in postgres gets parsed as a string by default
//https://github.com/sequelize/sequelize/issues/2383#issuecomment-58006083
require('pg').defaults.parseInt8 = true;
var messageQueue = require('./common/messageQueue.js');

var getValsFromInt = require('./common/getValuesFromIntegrationJson.js');

global.util = require('util');
global.shippableEx = 'shippableEx';

if (require.main === module) {
  init();
}

process.on('uncaughtException', function (err) {
  if (ignoreEADDRINUSE && err.errno === 'EADDRINUSE') {
    return;
  }
  _logErrorAndExit('Uncaught Exception thrown.', err);
});

function init() {
  var bag = {
    app: global.app,
    env: process.env,
    config: {}
  };

  async.series([
      _createExpressApp.bind(null, bag),
      _initializeDatabaseConfig.bind(null, bag),
      _setLogLevel.bind(null, bag),
      _initializeSequelize.bind(null, bag),
      _loadSystemConfig.bind(null, bag),
      _generateGlobalConfig.bind(null, bag),
      _initializeRoutes.bind(null, bag),
      _connectToRabbitMQ.bind(null, bag),
      require('./vortex/createQueues.js'),
      _cacheSystemProperties.bind(null, bag),
      _cacheSystemCodes.bind(null, bag),
      _cacheSystemConfigs.bind(null, bag),
      _loadAuthSystemIntegrations.bind(null, bag),
      _loadAuthSysIntSecrets.bind(null, bag),
      _loadAuthSysIntProviders.bind(null, bag),
      _startListening.bind(null, bag)
    ],
    function (err) {
      if (err) {
        logger.error(err);
        logger.error('Could not initialize api app');
      } else {
        logger.info(bag.who, 'Completed');
        global.app = bag.app;
        module.exports = global.app;
      }
    }
  );
}

function _createExpressApp(bag, next) {
  try {
    var app = express();

    // Set up morgan logging only if we're running in dev mode
    if (process.env.RUN_MODE === 'dev')
      app.use(require('morgan')('dev'));

    app.use(require('body-parser').json({limit: '10mb'}));
    app.use(require('body-parser').urlencoded({limit: '10mb', extended: true}));
    app.use(require('cookie-parser')());
    app.use(require('method-override')());
    app.use(require('./common/express/errorHandler.js'));
    app.use(require('./common/express/setCORSHeaders.js'));

    bag.app = app;
    return next();
  } catch (err) {
    _logErrorAndExit('Uncaught Exception thrown from createExpressApp.', err);
  }
}

function _initializeDatabaseConfig(bag, next) {
  var who = 'api.app.js|' + _initializeDatabaseConfig.name;

  var configErrors = [];

  var dbName=null;
  if (bag.env.DBNAME)
    bag.config.dbName = bag.env.DBNAME
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'DBNAME is not defined'));

  var dbUsername=null;
  if (bag.env.DBUSERNAME)
    bag.config.dbUsername = bag.env.DBUSERNAME
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'DBUSERNAME is not defined'));

  var dbPassword=null;
  if (bag.env.DBPASSWORD)
    bag.config.dbPassword = bag.env.DBPASSWORD
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'DBPASSWORD is not defined'));

  var dbHost =null;
  if (bag.env.DBHOST)
    bag.config.dbHost = bag.env.DBHOST
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'DBHOST is not defined'));

  var dbPort = null;
  if (bag.env.DBPORT)
    bag.config.dbPort = bag.env.DBPORT
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'DBPORT is not defined'));

  var dbDialect = null;
  if (bag.env.DBDIALECT)
    bag.config.dbDialect = bag.env.DBDIALECT
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'DBDIALECT is not defined'));

  if (configErrors.length)
    next(configErrors);
  else next();
}

function _setLogLevel(bag, next) {
  var who = 'api.app.js|' + _setLogLevel.name;
  logger.debug(who, 'Inside');

  var loggerConfig = {};
  if (bag.env.RUN_MODE)
    loggerConfig.runMode = bag.env.RUN_MODE;
  logger.configLevel(loggerConfig);

  return next();
}

function _initializeSequelize(bag, next) {
  var who = 'api.app.js|' + _initializeSequelize.name;
  logger.debug(who, 'Inside');

  var sequelizeOptions = {
    host: bag.config.dbHost,
    dialect: bag.config.dbDialect,

    // Defaults from the documentation. We may need to tweak this
    pool: {
      max: 5,
      min: 0,
      idle: 10000
    },

    // Setting native: true is required to use native pg bindings for SSL
    // support. However, this can't be set yet because libpq-dev cannot be
    // installed on appbase because of held packages. We should upgrade
    // appbase to the latest LTS release to fix this.
    //
    // Once appbase is fixed, npm install --save pg-native before uncommenting
    //native: true,

    // Wire up sequelize logging to Winston with a bind so all the sequelize
    // logs are qualified with "SEQUELIZE:" to make it easier to find
    logging: logger.debug.bind(null, 'SEQUELIZE:')
  };

  var sequelize = new Sequelize(
    bag.config.dbName,
    bag.config.dbUsername,
    bag.config.dbPassword,
    sequelizeOptions);

  global.sequelize = sequelize;

  // Initialize all the models
  glob.sync('./models/*.js').forEach(
    function (schemaPath) {
      logger.debug(who, 'Initializing schema file', schemaPath);
      require(schemaPath);
    }
  );

  sequelize.sync().asCallback(
    function (err) {
      if (err)
        return next(new ActErr(who, ActErr.OperationFailed,
          'Failed to sync sequelize', err)
        );

      logger.info('SEQUELIZE: Synced successfully');
      return next();
    }
  );
}

function _loadSystemConfig(bag, next) {
  var who = 'api.app.js|' + _loadSystemConfig.name;
  logger.debug(who, 'Inside');

  bag.timeoutLength = 1;
  bag.timeoutLimit = 180;

  __attempt(bag, next);

  function __attempt(bag, next) {

    var systemConfigs = require('./models/systemConfigs.js');
    systemConfigs.findOne({}).asCallback(
      function (err, systemConfigs) {
        if (err)
          return next(
            new ActErr(who, mapSequelizeErr(err),
              'systemConfigs.findOne failed with err: ' + err.message)
          );

        if (_.isEmpty(systemConfigs)) {
          logger.error(
            util.format('systemConfigs are empty. Retrying in %s seconds',
              bag.who, bag.timeoutLength*2)
          );
          bag.timeoutLength *= 2;
          if (bag.timeoutLength > bag.timeoutLimit)
            bag.timeoutLength = 1;
          setTimeout(function () {
            __attempt(bag, next);
          }, bag.timeoutLength * 1000);

          return;
        } else {
          bag.systemConfigs = systemConfigs.dataValues;
          return next();
        }
      }
    );
  }
}

function _generateGlobalConfig(bag, next) {
  /* jshint maxcomplexity:30 */
  var who = 'api.app.js|' + _generateGlobalConfig.name;
  logger.debug(who, 'Inside');

  /* jshint camelcase: false */

  var configErrors = [];

  bag.config.rootQueueList = bag.systemConfigs.rootQueueList.split('|');

  if (bag.systemConfigs.amqpUrl)
    bag.config.amqpUrl = bag.systemConfigs.amqpUrl;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'amqpUrl is not defined'));

  if (bag.systemConfigs.amqpUrlRoot)
    bag.config.rootAmqpUrl = bag.systemConfigs.amqpUrlRoot;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'rootAmqpUrl is not defined'));

  if (bag.systemConfigs.amqpUrlAdmin)
    bag.config.amqpManagementUrl = bag.systemConfigs.amqpUrlAdmin;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'amqpManagementUrl is not defined'));

  if (bag.systemConfigs.apiPort)
    bag.config.apiPort = bag.systemConfigs.apiPort;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'apiPort is not defined'));

  if (bag.systemConfigs.apiUrl)
    bag.config.apiUrl = bag.systemConfigs.apiUrl;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'apiUrl is not defined'));

  if (bag.systemConfigs.serviceUserToken)
    bag.config.apiToken = bag.systemConfigs.serviceUserToken;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'serviceUserToken is not defined'));

  if (bag.systemConfigs.wwwUrl)
    bag.config.feUrl = bag.systemConfigs.wwwUrl;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'wwwUrl is not defined'));

  /**
  if (process.env.BITBUCKET_CLIENT_ID)
    global.config.bitbucketClientId = process.env.BITBUCKET_CLIENT_ID;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'BITBUCKET_CLIENT_ID is not defined'));

  if (process.env.BITBUCKET_CLIENT_SECRET)
    global.config.bitbucketClientSecret = process.env.BITBUCKET_CLIENT_SECRET;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'BITBUCKET_CLIENT_SECRET is not defined'));

  if (process.env.BRAINTREE_ENVIRONMENT)
    global.config.braintreeEnvironment = process.env.BRAINTREE_ENVIRONMENT;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'BRAINTREE_ENVIRONMENT is not defined'));

  if (process.env.BRAINTREE_MERCHANT_ID)
    global.config.braintreeMerchantId = process.env.BRAINTREE_MERCHANT_ID;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'BRAINTREE_MERCHANT_ID is not defined'));

  if (process.env.BRAINTREE_PRIVATE_KEY)
    global.config.braintreePrivateKey = process.env.BRAINTREE_PRIVATE_KEY;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'BRAINTREE_PRIVATE_KEY not defined'));

  if (process.env.BRAINTREE_PUBLIC_KEY)
    global.config.braintreePublicKey = process.env.BRAINTREE_PUBLIC_KEY;
  else
    configErrors.push(new ActErr(who, ActErr.ParamNotFound,
      'BRAINTREE_PUBLIC_KEY is not defined'));

  if (process.env.REGISTRY_ACCESS_KEY)
    global.config.registryAccessKey = process.env.REGISTRY_ACCESS_KEY;

  if (process.env.REGISTRY_SECRET_KEY)
    global.config.registrySecretKey = process.env.REGISTRY_SECRET_KEY;

  if (process.env.REGISTRY_ACCESS_POLICY)
    global.config.registryAccessPolicy = process.env.REGISTRY_ACCESS_POLICY;

  if (process.env.REGISTRY_ACCOUNT_ID)
    global.config.registryAccountId = process.env.REGISTRY_ACCOUNT_ID;

  if (process.env.REGISTRY_REGION)
    global.config.registryRegion = process.env.REGISTRY_REGION;
  **/

  /* jshint camelcase: true*/
  if (bag.systemConfigs.runMode)
    bag.config.runMode = bag.systemConfigs.runMode;
  else
    bag.config.runMode = 'dev';

  bag.config.githubApiUrl = 'https://api.github.com';
  bag.config.bitbucketApiUrlv1 = 'https://bitbucket.org/api/1.0';
  bag.config.bitbucketApiUrlv2 = 'https://api.bitbucket.org/2.0';

  bag.config.apiRetryInterval = 3;

  global.config = bag.config;
  logger.debug('Platform config:', bag.config);
  if (configErrors.length)
    next(configErrors);

  else return next();

}

function _initializeRoutes(bag, next) {
  var who = 'api.app.js|' + _initializeRoutes.name;
  logger.debug(who, 'Inside');

  glob.sync('./**/*Routes.js').forEach(
    function(routeFile) {
      require(routeFile)(bag.app);
    }
  );
  return next();
}

function _connectToRabbitMQ (bag, next) {
  var who = 'api.app.js|' + _connectToRabbitMQ.name;
  logger.debug(who, 'Inside');

  global.AMQP = {};
  global.rootAMQP = {};

  var connections = [
    {
      amqpInstance: global.AMQP,
      url: config.amqpUrl
    },
    {
      amqpInstance: global.rootAMQP,
      url: config.rootAmqpUrl
    }
  ];

  async.eachSeries(connections,
    function (connection, done) {
      messageQueue(connection,
        function (err) {
          return done(err);
        }
      );
    },
    function (err) {
      return next(err);
    }
  );
}

function _cacheSystemProperties(app, next) {
  var who = 'api.app.js|' + _cacheSystemProperties.name;
  logger.verbose(who, 'Inside');

  var systemProperties = require('./models/systemProperties.js');
  systemProperties.findAll().asCallback(
    function (err, sysProps) {
      if (err)
        return next(
          new ActErr(who, mapSequelizeErr(err),
            'systemProperties.findAll failed with err: ' + err.message)
        );

      global.systemProperties = _.pluck(sysProps, 'fieldName');
      return next();
    }
  );
}

function _cacheSystemCodes(app, next) {
  var who = 'api.app.js|' + _cacheSystemCodes.name;
  logger.verbose(who, 'Inside');

  var systemCodes = require('./models/systemCodes.js');
  systemCodes.findAll().asCallback(
    function (err, sysCodes) {
      if (err)
        return next(
          new ActErr(who, mapSequelizeErr(err),
            'systemCodes.findAll failed with err: ' + err.message)
        );

      global.systemCodes = sysCodes;
      return next();
    }
  );
}

function _cacheSystemConfigs(app, next) {
  var who = 'api.app.js|' + _cacheSystemConfigs.name;
  logger.verbose(who, 'Inside');

  var systemConfigs = require('./models/systemConfigs.js');
  systemConfigs.findAll().asCallback(
    function (err, systemConfigs) {
      if (err)
        return next(
          new ActErr(who, mapSequelizeErr(err),
            'systemConfigs.findAll failed with err: ' + err.message)
        );

      global.systemConfig = _.first(systemConfigs);
      return next();
    }
  );
}

function _loadAuthSystemIntegrations(app, next) {
  var who = 'api.app.js|' + _loadAuthSystemIntegrations.name;
  logger.verbose(who, 'Inside');

  var systemIntegrations = require('./models/systemIntegrations.js');

  // We currently only care about bitbucket and bitbucketServer because they
  // are the only two auth providers we support today that need oauth consumer
  // key and secret to work
  var query = {
    where: {
      masterType: 'auth',
      $or: [
        { masterName: 'bitbucket' },
        { masterName: 'bitbucketServer' }
      ]
    }
  };

  systemIntegrations.findAll(query).asCallback(
    function (err, authSystemIntegrations) {
      if (err)
        return next(
          new ActErr(who, mapSequelizeErr(err),
            'systemIntegrations.findAll failed with err: ' + err.message)
        );

      global.config.authSystemIntegrations = authSystemIntegrations;
      return next();
    }
  );
}

function _loadAuthSysIntSecrets(app, next) {
  var who = 'api.app.js|' + _loadAuthSysIntSecrets.name;
  logger.verbose(who, 'Inside');

  var VaultAdapter = require('./common/vault/Adapter.js');
  var vaultUrl = global.systemConfig.vaultUrl;
  var shippableVaultToken = global.systemConfig.vaultToken;
  var vaultAdapter = new VaultAdapter(vaultUrl, shippableVaultToken);

  async.eachSeries(global.config.authSystemIntegrations,
    function (sysInt, loop) {
      var key = util.format('shippable/systemIntegrations/%s', sysInt.id);
      vaultAdapter.getSecret(key,
        function(err, body) {
          if (err)
            return loop(
              new ActErr(who, ActErr.OperationFailed,
                'Failed to getSecret for systemIntegrationId: ' +
                sysInt.id + ' with status code ' + err, body)
            );

          var formJSONValues = [];
          _.mapObject(body.data.data,
            function(value, key) {
              var formJSONField = {
                label: key,
                value: value
              };
              formJSONValues.push(formJSONField);
            }
          );

          sysInt.formJSONValues = formJSONValues;
          return loop();
        }
      );
    },
    function (err) {
      return next(err);
    }
  );
}

function _loadAuthSysIntProviders(app, next) {
  var who = 'api.app.js|' + _loadAuthSysIntProviders.name;
  logger.verbose(who, 'Inside');

  var providers = require('./models/providers.js');
  var authProviderIds = _.map(global.config.authSystemIntegrations,
    function (asi) {
      var jsonValues = getValsFromInt(asi.formJSONValues);
      var providerId = jsonValues.providerId;

      asi.providerId = providerId;
      asi.clientSecret = jsonValues.clientSecret;
      asi.clientKey = jsonValues.clientId;
      return providerId;
    }
  );

  var query = {
    where: {
      id: {
        $in: authProviderIds
      }
    }
  };

  providers.findAll(query).asCallback(
    function (err, providers) {
      if (err)
        return next(
          new ActErr(who, mapSequelizeErr(err),
            'providers.findAll failed with err: ' + err.message)
        );

      var providersById = _.indexBy(providers, 'id');
      global.config.oauthConsumerSettingsByProviderUrl = {};
      _.each(global.config.authSystemIntegrations,
        function (asi) {
          var providerUrl = providersById[asi.providerId].url;
          global.config.oauthConsumerSettingsByProviderUrl[providerUrl] = {
            clientKey: asi.clientKey,
            clientSecret: asi.clientSecret
          };
        }
      );

      return next();
    }
  );
}

function _startListening(bag, next) {
  var who = 'api.app.js|' + _startListening.name;
  logger.debug(who, 'Inside');

  var apiPort = bag.config.apiPort;
  var tries = 0;
  ignoreEADDRINUSE = true;
  listen();
  function listen(error) {
    if (!apiPort)
      return next(
        new ActErr(who, ActErr.InternalServer,
          'Failed to start server.', new Error('Invalid port.'))
      );
    if (!error) {
      try {
        bag.app.listen(apiPort, '0.0.0.0',
          _logServerListening.bind(null, apiPort, listen));
      } catch (err) {
        error = err;
      }
    }
    if (error) {
      if (tries > 3) {
        ignoreEADDRINUSE = false;
        var errMessage = 'Shippable API unable to listen: ' + apiPort;
        return next(
          new ActErr(who, ActErr.InternalServer, errMessage, error)
        );
      }
      tries += 1;
      listen();
    }
  }
}

function _logServerListening(port, listen, err) {
  var url = '0.0.0.0:' + port;
  if (err) return listen(err);
  logger.info('Shippable API started on %s.', url);
  ignoreEADDRINUSE = false;
}

function _logErrorAndExit(message, err) {
  logger.error(message);
  logger.error(err);
  if (err.stack) logger.error(err.stack);
  setTimeout(function () {
    process.exit();
  }, 3000);
}
