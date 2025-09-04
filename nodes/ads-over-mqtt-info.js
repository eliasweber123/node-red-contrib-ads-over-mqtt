module.exports = function (RED) {
  function AdsOverMqttInfo(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.status({ fill: "red", shape: "ring", text: "no connection" });
      node.error("No ADS connection configured");
      return;
    }

    const namespace = node.connection.topic;
    const localAmsNetId = node.connection.amsNetId;
    const infoTopic = `${namespace}/${localAmsNetId}/info`;
    const payload =
      '<info><online name="NODERED" osVersion="n/a" osPlatform="node-red">false</online></info>';

    function setDisconnected() {
      node.status({ fill: "red", shape: "ring", text: "disconnected" });
    }

    function setReady() {
      node.status({ fill: "green", shape: "dot", text: "ready" });
    }

    if (node.connection.client.connected) {
      setReady();
    } else {
      setDisconnected();
    }

    node._onConnect = setReady;
    node._onDisconnect = setDisconnected;
    node._onError = (err) => {
      node.status({ fill: "red", shape: "dot", text: "error" });
      node.error(err);
    };

    node.connection.client.on("connect", node._onConnect);
    node.connection.client.on("close", node._onDisconnect);
    node.connection.client.on("offline", node._onDisconnect);
    node.connection.client.on("error", node._onError);

    node.publishInfo = function () {
      if (!node.connection.client.connected) {
        setDisconnected();
        node.error("MQTT client not connected");
        return;
      }
      node.connection.client.publish(
        infoTopic,
        payload,
        { qos: 0, retain: true },
        (err) => {
          if (err) {
            node.status({ fill: "red", shape: "dot", text: "publish error" });
            node.error(err);
          } else {
            node.status({
              fill: "green",
              shape: "dot",
              text: `published ${infoTopic}`,
            });
          }
        }
      );
    };

    node.on("close", () => {
      node.connection.client.off("connect", node._onConnect);
      node.connection.client.off("close", node._onDisconnect);
      node.connection.client.off("offline", node._onDisconnect);
      node.connection.client.off("error", node._onError);
    });
  }

  RED.nodes.registerType("ads-over-mqtt-info", AdsOverMqttInfo);

  RED.httpAdmin.post(
    "/ads-over-mqtt-info/:id/publish",
    RED.auth.needsPermission("ads-over-mqtt-info.write"),
    function (req, res) {
      const node = RED.nodes.getNode(req.params.id);
      if (node) {
        try {
          node.publishInfo();
          res.sendStatus(200);
        } catch (err) {
          node.error(err);
          res.sendStatus(500);
        }
      } else {
        res.sendStatus(404);
      }
    }
  );
};
