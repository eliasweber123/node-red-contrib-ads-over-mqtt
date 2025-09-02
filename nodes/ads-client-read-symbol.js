module.exports = function(RED) {
  function AdsClientReadSymbol(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.symbol = config.symbol;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error('No ADS connection configured');
      return;
    }

    node.connection.client.on('message', function(topic, message) {
      try {
        const res = JSON.parse(message.toString());
        if (topic === 'ads/response' && res.symbol === node.pending) {
          node.pending = null;
          node.send({payload: res.value, symbol: res.symbol});
        }
      } catch (err) {
        node.error(err);
      }
    });

    node.on('input', function(msg, send, done) {
      const symbol = msg.symbol || node.symbol;
      if (!symbol) {
        done(new Error('No symbol specified'));
        return;
      }
      node.pending = symbol;
      const req = {
        amsNetId: node.connection.amsNetId,
        targetAmsNetId: node.connection.targetAmsNetId,
        port: node.connection.port,
        symbol
      };
      node.connection.client.publish('ads/read', JSON.stringify(req));
      done();
    });
  }
  RED.nodes.registerType('ads-client-read-symbol', AdsClientReadSymbol);
};
