'use strict';

var request = require('request');
var Url = require('url'),
util = require('util'),
EventEmitter = require('events').EventEmitter,
httpProxy = require('http-proxy'),
_ = require('lodash'),
proxy = new httpProxy.createProxyServer(),
ProxyKeystone = function(customOptions){
  var self = this;

  self.options = {
    token: 'user.token',
    userId: 'user.userId',
    catalog: 'user.serviceCatalog',
    userAgent: ''
  };

  if(customOptions){
    for(var i in customOptions){
      self.options[i] = customOptions[i];
    }
  }

  self.getValueByString = function (o, s) {
    var a = s.split('.');
    while (a.length) {
      var n = a.shift();
      if (n in o) {
          o = o[n];
      } else {
          return false;
      }
    }
    return o;
  };

  self.parseService = function (service) {
    var segments = service.split(','),
    data = {
      name: segments[0]
    };

    if (segments.length === 2) {
      data.region = segments[1];
    }

    self.emit('log:parseService', data);
    return data;
  };

  self.getServiceByName = function (name, catalog) {
    if (catalog instanceof Array) {
      return _.find(catalog, function(item) {
        return name === item.name;
      });
    } else {
      return catalog[name];
    }
  };

  self.findEndpoint = function (serviceInfo, service) {
    if (serviceInfo.region){
      return _.find(service.endpoints, function(endpoint) {
        return serviceInfo.region === endpoint.region;
      });
    } else {
      return service.endpoints[0];
    }
  };

  self.middleware = function (req, res, next) {
    var error, token, catalog, serviceParams, service,
    endpoint, endpointInfo, target, serviceInfo, userId,
    proxyUrl = req.route.path.replace(/\*$/, '');

    // Handle body parser issues
    req.removeAllListeners('data');
    req.removeAllListeners('end');
    process.nextTick(function () {
      if(req.body) {
        req.emit('data', JSON.stringify(req.body));
      }
      req.emit('end');
    });

    // set token and serviceCatalog
    token = self.getValueByString(req, self.options.token);
    userId = self.getValueByString(req, self.options.userId);
    catalog = self.getValueByString(req, self.options.catalog);

    if(!token && !userId){
      error = new Error('Missing token/userId');
      self.emit('proxyError', error);
      return next(error);
    }
    if (!catalog) {
      error = new Error('Missing Service Catalog');
      self.emit('proxyError', error);
      return next(error);
    }

    // begin req.url transformation
    req.url = req.url.split(proxyUrl)[1]; // remove /proxy/
    if (req.service) {
      serviceParams = req.service;
    }
    else {
      serviceParams = req.url.split('/')[0]; // grabs 'catalogItem,[region]'
      req.url = req.url.split(serviceParams)[1]; // transform req.url
    }

    serviceInfo = self.parseService(serviceParams);

    // grab service from catalog based on name
    service = self.getServiceByName(serviceInfo.name, catalog);

    // check if service exists
    if (!service){
      error = new Error('Service Catalog Item Not Found');
      self.emit('proxyError', error);
      return next(error);
    }

    endpoint = self.findEndpoint(serviceInfo, service);

    if (!endpoint) {
      error = new Error('Endpoint Not Found In ' + service.name);
      self.emit('proxyError', error);
      return next(error);
    }

    // url.parse creates an object
    endpointInfo = Url.parse(endpoint.publicURL);
    if (endpointInfo.path != '/') {
      target = endpoint.publicURL.split(endpointInfo.path)[0];
    }
    else {
      target = endpoint.publicURL;
    }
    req.url = endpointInfo.pathname + req.url;

    // Set headers
    req.headers = {};
    req.headers['X-Auth-Token'] = token;
    req.headers['X-Auth-User'] = userId;
    req.headers['Accept'] = 'application/json';
    req.headers['Content-Type'] = 'application/json';
    if (self.options.userAgent){
      req.headers['User-Agent'] = self.options.userAgent;
    }

    // dirty hacks for POST/PUT requests
    if (req.method == 'POST' || req.method == 'PUT') {
      request({
        method: req.method,
        url: target + req.url,
        headers: req.headers,
        json: req.body
      }, function(error, response, body) {
        if (error) {
          next(error);
        }
        else {
          res.json(body);
        }
      });
    }
    else {
      proxy.on('start', function(req, res, target){
        self.emit('proxyStart', req, res, target);
      });

      proxy.on('end', function(req, res, proxyRes){
        self.emit('proxyEnd', req, res, proxyRes);
      });

      proxy.on('error', function (err) {
        self.emit('proxyError', err);
        next(err);
      });

      proxy.web(req, res, {
        target: target
      });
    
    }
  };

};

util.inherits(ProxyKeystone, EventEmitter);

module.exports = ProxyKeystone;
