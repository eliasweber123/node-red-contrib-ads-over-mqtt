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

    node.on('input', function(msg, send, done) {
      const symbol = msg.symbol || node.symbol;
      const value = msg.payload;
      if (!symbol) {
        done(new Error('No symbol specified'));
        return;
      }
      const req = {
        amsNetId: node.connection.amsNetId,
        targetAmsNetId: node.connection.targetAmsNetId,
        port: node.connection.port,
        symbol,
        value
      };
      node.connection.client.publish('ads/write', JSON.stringify(req));
      send(msg);
      done();
    });
  }
  RED.nodes.registerType('ads-over-mqtt-write-symbols', AdsOverMqttWriteSymbols);
};
