module.exports = function (RED) {
  function AdsOverMqttDebug(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.pfad = config.pfad;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error("No ADS connection configured");
      return;
    }

    if (!node.pfad) {
      node.status({ fill: "red", shape: "ring", text: "missing topic" });
      node.error("ads-over-mqtt-debug: pfad is empty");
      return;
    }

    node.status({ fill: "yellow", shape: "ring", text: "subscribing…" });

    node._onMessage = (topic, message) => {
      if (topic === node.pfad) {
        node.send({ payload: message, topic });
      }
    };

    node.connection.client.on("message", node._onMessage);
    node.connection.client.subscribe(node.pfad, (err) => {
      if (err) {
        node.status({ fill: "red", shape: "dot", text: "subscribe error" });
        node.error(err);
      } else {
        node.status({ fill: "green", shape: "dot", text: "listening" });
      }
    });

    node.on("close", (done) => {
      if (node._onMessage) {
        node.connection.client.off("message", node._onMessage);
      }
      node.connection.client.unsubscribe(node.pfad, done);
    });
  }

  RED.nodes.registerType("ads-over-mqtt-debug", AdsOverMqttDebug);
};
