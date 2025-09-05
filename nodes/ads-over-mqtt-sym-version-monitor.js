module.exports = function (RED) {
  function AdsOverMqttSymVersionMonitor(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);
    node.interval = Number(config.interval) || 1;
    node.unit = config.unit || "s";
    let intervalMs = node.interval;
    if (node.unit === "ms") intervalMs = node.interval;
    else if (node.unit === "min") intervalMs = node.interval * 60000;
    else intervalMs = node.interval * 1000; // default seconds

    if (!node.connection || !node.connection.client) {
      node.error("No ADS connection configured");
      return;
    }

    const client = node.connection.client;
    const namespace = node.connection.topic;
    const targetAms = node.connection.targetAmsNetId;
    const resTopic = `${namespace}/${node.connection.amsNetId}/ams/res`;
    const infoTopic = `${namespace}/${targetAms}/info`;

    if (!node.connection._subscribedRes) {
      client.subscribe(resTopic);
      node.connection._subscribedRes = true;
    }
    client.subscribe(infoTopic);

    let lastSymVersion;
    let lastOnline;
    node._invokeId = 1;
    node.pending = {};

    function amsNetIdToBuffer(id) {
      return Buffer.from(id.split('.').map((n) => parseInt(n, 10)));
    }

    function sendOutput(source, currentSymVersion, prevSymVersion) {
      const msg = { payload: "liste aktualisiert", source };
      if (currentSymVersion !== undefined) msg.currentSymVersion = currentSymVersion;
      if (prevSymVersion !== undefined) msg.prevSymVersion = prevSymVersion;
      node.send([msg, null, null]);
    }

    function readSymVersion(callback) {
      const adsRead = Buffer.alloc(12);
      adsRead.writeUInt32LE(0xf008, 0);
      adsRead.writeUInt32LE(0, 4);
      adsRead.writeUInt32LE(4, 8);

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(targetAms).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.sourcePort, 14);
      amsHeader.writeUInt16LE(0x0002, 16); // Read command
      amsHeader.writeUInt16LE(0x0004, 18); // State flags
      amsHeader.writeUInt32LE(adsRead.length, 20);
      amsHeader.writeUInt32LE(0, 24);
      const invokeId = node._invokeId++ & 0xffffffff;
      amsHeader.writeUInt32LE(invokeId, 28);

      const frame = Buffer.concat([amsHeader, adsRead]);
      const reqTopic = `${namespace}/${targetAms}/ams`;
      node.pending[invokeId] = callback || true;
      client.publish(reqTopic, frame, { qos: 0, retain: false });
    }

    function restart() {
      lastSymVersion = undefined;
      lastOnline = undefined;
      node.status({ fill: "grey", shape: "ring", text: "waiting info" });
      readSymVersion();
    }
    node.restart = restart;

    node.on("input", () => {
      readSymVersion((current) => {
        node.send([null, { payload: current }, null]);
      });
      node.send([null, null, { payload: !!lastOnline }]);
    });

    client.on("message", (topic, message) => {
      if (topic === resTopic) {
        if (!Buffer.isBuffer(message) || message.length < 40) {
          node.error("Invalid AMS response frame");
          return;
        }
        const invokeId = message.readUInt32LE(28);
        const cb = node.pending[invokeId];
        if (!cb) return;
        delete node.pending[invokeId];
        const result = message.readUInt32LE(32);
        const len = message.readUInt32LE(36);
        const data = message.slice(40, 40 + len);
        if (result !== 0) {
          sendOutput("sym_version");
          return;
        }
        if (len >= 4) {
          const current = data.readUInt32LE(0);
          if (typeof cb === "function") {
            cb(current);
          } else {
            if (lastSymVersion === undefined) {
              lastSymVersion = current;
              if (lastOnline !== undefined) {
                node.status({ fill: "green", shape: "dot", text: "running / monitoring" });
              }
            } else if (current > lastSymVersion) {
              sendOutput("sym_version", current, lastSymVersion);
              lastSymVersion = current;
            }
          }
        }
      } else if (topic === infoTopic) {
        const payload = message.toString();
        const match = payload.match(/>(true|false)<\/online>/i);
        if (match) {
          const currentOnline = match[1].toLowerCase() === "true";
          if (lastOnline === false && currentOnline) {
            sendOutput("infoTopic");
          }
          lastOnline = currentOnline;
          if (lastSymVersion !== undefined) {
            node.status({ fill: "green", shape: "dot", text: "running / monitoring" });
          }
        } else {
          node.status({ fill: "yellow", shape: "ring", text: "warte auf erstes Info-Topic" });
        }
      }
    });

    const timer = setInterval(readSymVersion, intervalMs);
    node.on("close", () => {
      clearInterval(timer);
      client.unsubscribe(infoTopic);
    });

    restart();
  }

  RED.nodes.registerType(
    "ads-over-mqtt-sym-version-monitor",
    AdsOverMqttSymVersionMonitor
  );

  RED.httpAdmin.post(
    "/ads-over-mqtt-sym-version-monitor/:id/restart",
    RED.auth.needsPermission("ads-over-mqtt-sym-version-monitor.write"),
    function (req, res) {
      const node = RED.nodes.getNode(req.params.id);
      if (node) {
        try {
          node.restart();
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
