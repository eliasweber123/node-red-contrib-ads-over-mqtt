module.exports = function (RED) {
  function AdsOverMqttSymbolLoader(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error("No ADS connection configured");
      return;
    }

    const namespace = node.connection.topic;
    const resTopic = `${namespace}/${node.connection.amsNetId}/ams/res`;

    if (!node.connection._subscribedRes) {
      node.connection.client.subscribe(resTopic);
      node.connection._subscribedRes = true;
    }

    node.pendingRequests = {};
    node._invokeId = 1;

    function amsNetIdToBuffer(id) {
      return Buffer.from(id.split('.').map((n) => parseInt(n, 10)));
    }

    node.connection.client.on("message", (topic, message) => {
      if (topic !== resTopic) return;
      if (!Buffer.isBuffer(message) || message.length < 40) {
        node.error("Invalid AMS response frame");
        return;
      }
      const invokeId = message.readUInt32LE(28);
      const pending = node.pendingRequests[invokeId];
      if (!pending) return;

      clearTimeout(pending.timer);
      const result = message.readUInt32LE(32);
      const len = message.readUInt32LE(36);
      const data = message.slice(40, 40 + len);

      delete node.pendingRequests[invokeId];
      if (result !== 0) {
        pending.callback(new Error(`ADS error ${result}`));
      } else {
        pending.callback(null, data);
      }
    });

    function sendAdsRead(ig, io, length, cb) {
      const adsRead = Buffer.alloc(12);
      adsRead.writeUInt32LE(ig, 0);
      adsRead.writeUInt32LE(io, 4);
      adsRead.writeUInt32LE(length, 8);

      const amsHeader = Buffer.alloc(32);
      amsNetIdToBuffer(node.connection.targetAmsNetId).copy(amsHeader, 0);
      amsHeader.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(amsHeader, 8);
      amsHeader.writeUInt16LE(node.connection.sourcePort, 14);
      amsHeader.writeUInt16LE(0x0002, 16); // CmdID Read
      amsHeader.writeUInt16LE(0x0004, 18); // StateFlags
      amsHeader.writeUInt32LE(adsRead.length, 20);
      amsHeader.writeUInt32LE(0, 24);
      const invokeId = node._invokeId++ & 0xffffffff;
      amsHeader.writeUInt32LE(invokeId, 28);

      const frame = Buffer.concat([amsHeader, adsRead]);
      const reqTopic = `${namespace}/${node.connection.targetAmsNetId}/ams`;

      node.pendingRequests[invokeId] = {
        callback: cb,
        timer: setTimeout(() => {
          delete node.pendingRequests[invokeId];
          cb(new Error("Timeout"));
        }, 5000),
      };

      node.send([
        null,
        { payload: frame.toString("hex"), topic: reqTopic },
        { payload: frame, topic: reqTopic },
      ]);
      node.connection.client.publish(reqTopic, frame, { qos: 0, retain: false });
    }

    function parseSymbols(buffer) {
      const symbols = [];
      let offset = 0;
      while (offset + 30 <= buffer.length) {
        const entryLen = buffer.readUInt32LE(offset);
        if (entryLen < 30 || offset + entryLen > buffer.length) {
          break;
        }
        const indexGroup = buffer.readUInt32LE(offset + 4);
        const indexOffset = buffer.readUInt32LE(offset + 8);
        const size = buffer.readUInt32LE(offset + 12);
        const dataType = buffer.readUInt32LE(offset + 16);
        const flags = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 24);
        const typeLength = buffer.readUInt16LE(offset + 26);
        const commentLength = buffer.readUInt16LE(offset + 28);

        const nameStart = offset + 30;
        const name = buffer
          .slice(nameStart, nameStart + nameLength)
          .toString("utf8")
          .replace(/\0+$/, "");

        let typeStart = nameStart + nameLength;
        let typeLen = typeLength;
        if (typeLen > 0 && buffer[typeStart] === 0x00) {
          typeStart += 1;
          typeLen -= 1;
        }
        const typeName = buffer
          .slice(typeStart, typeStart + typeLen)
          .toString("utf8")
          .replace(/\0+$/, "");

        let commentStart = typeStart + typeLen;
        let commentLen = commentLength;
        if (commentLen > 0 && buffer[commentStart] === 0x00) {
          commentStart += 1;
          commentLen -= 1;
        }
        const comment = buffer
          .slice(commentStart, commentStart + commentLen)
          .toString("utf8")
          .replace(/\0+$/, "");

        // Move to the next entry based on the provided entry length
        symbols.push({
          name,
          indexGroup,
          indexOffset,
          size,
          typeName,
          comment,
          dataType,
          flags,
        });
        offset += entryLen;
      }
      return symbols;
    }

    function loadSymbols() {
      node.status({ fill: "blue", shape: "dot", text: "loading" });
      sendAdsRead(0xf00c, 0, 24, (err, info) => {
        if (err || !info || info.length < 8) {
          node.status({ fill: "red", shape: "ring", text: "uploadInfo" });
          node.error(err || new Error("Failed to read symbol upload info"));
          return;
        }
        const symCount = info.readUInt32LE(0);
        const symSize = info.readUInt32LE(4);
        if (symSize === 0) {
          node.status({ fill: "red", shape: "ring", text: "empty" });
          node.error(new Error("Symbol table empty"));
          return;
        }

        sendAdsRead(0xf00b, 0, symSize, (err2, table) => {
          if (err2 || !table) {
            node.status({ fill: "red", shape: "ring", text: "symbol upload" });
            node.error(err2 || new Error("Failed to read symbol table"));
            return;
          }
          const symbols = parseSymbols(table);

          // store in flow context namespaced by topic/target
          const flowContext = node.context().flow;
          const flowSymbols = flowContext.get("symbols") || {};
          const key = `${namespace}/${node.connection.targetAmsNetId}`;
          flowSymbols[key] = symbols;
          flowContext.set("symbols", flowSymbols);

          // store in global for compatibility
          const globalContext = node.context().global;
          const all = globalContext.get("symbols") || {};
          if (!all[node.connection.id]) all[node.connection.id] = {};
          const target = {};
          symbols.forEach((s) => {
            target[s.name] = {
              ig: s.indexGroup,
              io: s.indexOffset,
              size: s.size,
              datatype: s.dataType,
            };
          });
          all[node.connection.id][node.connection.targetAmsNetId] = target;
          globalContext.set("symbols", all);

          node.status({
            fill: "green",
            shape: "dot",
            text: `${symbols.length} symbols`,
          });
          node.send([
            { payload: symbols, count: symCount, size: symSize },
            null,
            null,
          ]);
        });
      });
    }

    node.on("input", () => {
      loadSymbols();
    });

    node.on("close", () => {
      Object.values(node.pendingRequests).forEach((p) => clearTimeout(p.timer));
    });
  }

  RED.nodes.registerType(
    "ads-over-mqtt-symbol-loader",
    AdsOverMqttSymbolLoader
  );
};
