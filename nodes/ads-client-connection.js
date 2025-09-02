// nodes/ads-client-connection.js
module.exports = function (RED) {
  const mqtt = require("mqtt");

  function AdsClientConnection(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // --- Config ---
    node.brokerUrl = (config.brokerUrl || "").trim();
    node.amsNetId = (config.amsNetId || "").trim();
    node.targetAmsNetId = (config.targetAmsNetId || "").trim();
    node.port = Number(config.port) || 851;

    const { username, password } = node.credentials || {};
    const clientId =
      (config.clientId && String(config.clientId).trim()) ||
      "node-red-ads-" + Math.random().toString(16).slice(2, 10);

    if (!node.brokerUrl) {
      node.status({ fill: "red", shape: "ring", text: "missing brokerUrl" });
      node.error("ads-client-connection: brokerUrl fehlt");
      return;
    }

    const options = {
      clientId,
      username,
      password,
      keepalive: 60,
      reconnectPeriod: 2000, // 2s auto-reconnect
      clean: true,
    };

    // --- Connect ---
    try {
      node.status({ fill: "yellow", shape: "ring", text: "connecting…" });
      node.client = mqtt.connect(node.brokerUrl, options);
    } catch (err) {
      node.status({ fill: "red", shape: "dot", text: "connect error" });
      node.error(err);
      return;
    }

    // --- Events ---
    node.client.on("connect", () => {
      node.log("ADS over MQTT connected");
      node.status({ fill: "green", shape: "dot", text: "connected" });
    });

    node.client.on("reconnect", () => {
      node.status({ fill: "yellow", shape: "ring", text: "reconnecting…" });
    });

    node.client.on("offline", () => {
      node.status({ fill: "red", shape: "ring", text: "offline" });
    });

    node.client.on("close", () => {
      node.status({ fill: "grey", shape: "ring", text: "closed" });
    });

    node.client.on("error", (err) => {
      node.status({ fill: "red", shape: "dot", text: "error" });
      node.error(err);
    });

    // --- Cleanup ---
    node.on("close", function (done) {
      if (node.client) {
        // mqtt v4: end(force?, options?, cb?)
        node.client.end(true, {}, done);
      } else {
        done();
      }
    });

    // Optional: expose minimal API for other nodes (via getNode)
    node.getConnectionInfo = function () {
      return {
        brokerUrl: node.brokerUrl,
        amsNetId: node.amsNetId,
        targetAmsNetId: node.targetAmsNetId,
        port: node.port,
        client: node.client,
      };
    };
  }

  RED.nodes.registerType("ads-client-connection", AdsClientConnection, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" },
    },
  });
};
