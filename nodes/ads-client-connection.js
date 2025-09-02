module.exports = function(RED) {
  const mqtt = require('mqtt');

  function AdsClientConnection(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.brokerUrl = config.brokerUrl;
    node.amsNetId = config.amsNetId;
    node.targetAmsNetId = config.targetAmsNetId;
    node.port = config.port;

    const options = {
      clientId: config.clientId || 'node-red-ads-' + Math.random().toString(16).substr(2, 8),
      username: node.credentials.username,
      password: node.credentials.password
    };

    node.client = mqtt.connect(node.brokerUrl, options);
    node.client.on('connect', () => node.log('ADS over MQTT connected'));
    node.client.on('error', err => node.error(err));

    node.on('close', function(done) {
      if (node.client) {
        node.client.end(true, done);
      } else {
        done();
      }
    });
  }

  RED.nodes.registerType('ads-client-connection', AdsClientConnection, {
    credentials: {
      username: {type: 'text'},
      password: {type: 'password'}
    }
  });
};
