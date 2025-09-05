module.exports = function (RED) {
  function AdsOverMqttGvl(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const prefixStr = config.gvlPrefixes || (Array.isArray(config.gvls) ? config.gvls.join(';') : '');
    node.gvlPrefixes = prefixStr;
    node.gvls = Array.from(new Set(prefixStr.split(/[;,]/).map(p => p.trim()).filter(p => p)));
    node.cycle = config.cycle === true || config.cycle === "true";
    node.interval = Number(config.interval) || 1;
    node.unit = config.unit || "s";
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection || !node.connection.client) {
      node.error("No ADS connection configured");
      return;
    }

    const client = node.connection.client;
    const namespace = node.connection.topic;
    const targetAms = node.connection.targetAmsNetId;
    if (!targetAms) {
      node.error("No target AMS Net ID specified");
      return;
    }
    const resTopic = `${namespace}/${node.connection.amsNetId}/ams/res`;

    if (!node.connection._subscribedRes) {
      client.subscribe(resTopic);
      node.connection._subscribedRes = true;
    }

    node.pending = {};
    node._invokeId = 1;

    function amsNetIdToBuffer(id) {
      return Buffer.from(id.split('.').map((n) => parseInt(n, 10)));
    }

    function buildAmsHeader(len, cmdId) {
      const header = Buffer.alloc(32);
      amsNetIdToBuffer(targetAms).copy(header, 0);
      header.writeUInt16LE(node.connection.port, 6);
      amsNetIdToBuffer(node.connection.amsNetId).copy(header, 8);
      header.writeUInt16LE(node.connection.sourcePort, 14);
      header.writeUInt16LE(cmdId, 16);
      header.writeUInt16LE(0x0004, 18);
      header.writeUInt32LE(len, 20);
      header.writeUInt32LE(0, 24);
      const invokeId = node._invokeId++ & 0xffffffff;
      header.writeUInt32LE(invokeId, 28);
      return header;
    }

    function performRead(send, done) {
      const flowContext = node.context().flow;
      const symbolsMap = flowContext.get("symbols") || {};
      const key = `${namespace}/${targetAms}`;
      const allSymbols = symbolsMap[key] || [];
      const prefixes = node.gvls;
      const symbols = allSymbols.filter((s) =>
        prefixes.some((p) => s.name.startsWith(`${p}.`))
      );
      if (symbols.length === 0) {
        if (done) done(new Error("No matching symbols"));
        else node.warn("No matching symbols");
        return;
      }

      const n = symbols.length;
      const subReqs = Buffer.alloc(n * 16);
      const nameBuffers = [];
      let offset = 0;
      const ADSIGRP_SYM_HNDBYNAME = 0xf003;
      for (let i = 0; i < n; i++) {
        const nameBuf = Buffer.from(symbols[i].name + "\0", "utf8");
        subReqs.writeUInt32LE(ADSIGRP_SYM_HNDBYNAME, offset);
        subReqs.writeUInt32LE(0, offset + 4);
        subReqs.writeUInt32LE(4, offset + 8);
        subReqs.writeUInt32LE(nameBuf.length, offset + 12);
        nameBuffers.push(nameBuf);
        offset += 16;
      }
      const writeData = Buffer.concat([subReqs, ...nameBuffers]);
      const readLen = n * 8;
      const IG_SUM_RW = 0xf082;
      const adsRw = Buffer.alloc(16);
      adsRw.writeUInt32LE(IG_SUM_RW, 0);
      adsRw.writeUInt32LE(n, 4);
      adsRw.writeUInt32LE(readLen, 8);
      adsRw.writeUInt32LE(writeData.length, 12);
      const payload = Buffer.concat([adsRw, writeData]);
      const amsHeader = buildAmsHeader(payload.length, 0x0009);
      const frame = Buffer.concat([amsHeader, payload]);
      const reqTopic = `${namespace}/${targetAms}/ams`;
      const invokeId = amsHeader.readUInt32LE(28);
      node.pending[invokeId] = { type: "handles", symbols, send, done };
      client.publish(reqTopic, frame, { qos: 0, retain: false });
    }

    client.on("message", (topic, message) => {
      if (topic !== resTopic) return;
      if (!Buffer.isBuffer(message) || message.length < 40) {
        node.error("Invalid AMS response frame");
        return;
      }
      const invokeId = message.readUInt32LE(28);
      const pending = node.pending[invokeId];
      if (!pending) return;
      delete node.pending[invokeId];
      const result = message.readUInt32LE(32);
      const len = message.readUInt32LE(36);
      const data = message.slice(40, 40 + len);

      if (pending.type === "handles") {
        if (result !== 0) {
          if (pending.done) pending.done(new Error(`ADS error ${result}`));
          else node.error(`ADS error ${result}`);
          return;
        }
        const n = pending.symbols.length;
        const resCodes = [];
        for (let i = 0; i < n; i++) {
          resCodes[i] = data.readUInt32LE(i * 4);
        }
        let offset = n * 4;
        const handles = [];
        const symbols = [];
        for (let i = 0; i < n; i++) {
          const rc = resCodes[i];
          if (rc === 0) {
            handles.push(data.readUInt32LE(offset));
            symbols.push(pending.symbols[i]);
          } else {
            node.error(`Handle error for ${pending.symbols[i].name}: ${rc}`);
          }
          offset += 4;
        }
        if (handles.length === 0) {
          if (pending.done) pending.done();
          return;
        }
        const m = handles.length;
        const subReqs = Buffer.alloc(m * 16);
        let writeOffset = 0;
        let totalRead = 0;
        const ADSIGRP_SYM_VALBYHND = 0xf005;
        for (let i = 0; i < m; i++) {
          const sym = symbols[i];
          subReqs.writeUInt32LE(ADSIGRP_SYM_VALBYHND, writeOffset);
          subReqs.writeUInt32LE(handles[i], writeOffset + 4);
          subReqs.writeUInt32LE(sym.size, writeOffset + 8);
          subReqs.writeUInt32LE(0, writeOffset + 12);
          writeOffset += 16;
          totalRead += sym.size;
        }
        const IG_SUM_READ = 0xf080;
        const readLen = m * 4 + totalRead;
        const adsRw = Buffer.alloc(16);
        adsRw.writeUInt32LE(IG_SUM_READ, 0);
        adsRw.writeUInt32LE(m, 4);
        adsRw.writeUInt32LE(readLen, 8);
        adsRw.writeUInt32LE(subReqs.length, 12);
        const payload = Buffer.concat([adsRw, subReqs]);
        const amsHeader = buildAmsHeader(payload.length, 0x0009);
        const frame = Buffer.concat([amsHeader, payload]);
        const reqTopic = `${namespace}/${targetAms}/ams`;
        const invokeId2 = amsHeader.readUInt32LE(28);
        node.pending[invokeId2] = {
          type: "read",
          symbols,
          send: pending.send,
          done: pending.done,
        };
        client.publish(reqTopic, frame, { qos: 0, retain: false });
      } else if (pending.type === "read") {
        if (pending.send) pending.send([{ payload: message }, null]);
        else node.send([{ payload: message }, null]);
        let invalid = result === 0x711;
        const n = pending.symbols.length;
        if (!invalid && len >= n * 4) {
          for (let i = 0; i < n; i++) {
            const rc = data.readUInt32LE(i * 4);
            if (rc === 0x711) invalid = true;
            else if (rc !== 0) {
              node.error(`Read error for ${pending.symbols[i].name}: ${rc}`);
            }
          }
        }
        if (invalid) {
          if (pending.send) pending.send([null, { payload: "Invalid symbol version" }]);
          else node.send([null, { payload: "Invalid symbol version" }]);
        }
        if (pending.done) pending.done();
      }
    });

    node.on("input", (msg, send, done) => {
      performRead(send, done);
    });

    let timer;
    if (node.cycle) {
      let intervalMs = node.interval;
      if (node.unit === "min") intervalMs = node.interval * 60000;
      else if (node.unit === "s") intervalMs = node.interval * 1000;
      timer = setInterval(() => performRead(node.send.bind(node)), intervalMs);
    }

    node.on("close", () => {
      if (timer) clearInterval(timer);
    });
  }

  RED.nodes.registerType("ads-over-mqtt-gvl", AdsOverMqttGvl);
};
