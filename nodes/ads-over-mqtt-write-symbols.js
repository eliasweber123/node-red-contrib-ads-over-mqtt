module.exports = function(RED) {
  function AdsOverMqttWriteSymbols(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error('No ADS connection configured');
      return;
    }

    const reqTopic = `${node.connection.clientId}/${node.connection.targetAmsNetId}/ads/req`;
    const resTopic = `${node.connection.clientId}/${node.connection.targetAmsNetId}/ams/res`;

    if (!node.connection._subscribedRes) {
      node.connection.client.subscribe(resTopic);
      node.connection._subscribedRes = true;
    }

    node.connection.client.on('message', function(topic, message) {
      try {
        const res = JSON.parse(message.toString());
        if (topic === resTopic && res.symbol === node.pending) {
          node.pending = null;
          node.send({payload: res, symbol: res.symbol});
        }
      } catch (err) {
        node.error(err);
      }
    });

    node.on('input', function(msg, send, done) {
      const symbol = msg.symbol || node.symbol;
      const value = msg.payload;
      if (!symbol) {
        done(new Error('No symbol specified'));
        return;
      }
      node.pending = symbol;
      const req = {
        amsNetId: node.connection.amsNetId,
        targetAmsNetId: node.connection.targetAmsNetId,
        port: node.connection.port,
        symbol,
        value
      };
      node.connection.client.publish(reqTopic, JSON.stringify(req));
      done();
    });
  }
  RED.nodes.registerType('ads-over-mqtt-write-symbols', AdsOverMqttWriteSymbols);
};
