# node-red-contrib-ads-over-mqtt

This repository provides a set of [Node-RED](https://nodered.org/) nodes for
communicating with Beckhoff TwinCAT ADS devices over an MQTT broker. The nodes
are intended as a starting point for building flows that read from and write to
ADS symbols using MQTT messages.

## Nodes

- **ads-over-mqtt-client-connection** – configuration node that establishes the MQTT
  connection and holds AMS routing parameters.
- **ads-over-mqtt-client-read-symbols** – reads the value of a given ADS symbol. The symbol
  can be configured in the node or supplied as `msg.symbol`.
- **ads-over-mqtt-write-symbols** – writes a value from `msg.payload` to the
  specified ADS symbol.

These nodes publish requests to `VirtualAmsNetwork1/<targetAmsNetId>/ams` and
listen for responses on `VirtualAmsNetwork1/<targetAmsNetId>/ams/res`. Messages
on the old `<clientId>/<targetAmsNetId>/ams` topics are still accepted but will
produce a warning.

Payloads are raw ADS/AMS frames. Within Node-RED flows they are represented as
Buffers. When serialising to JSON (for example for MQTT nodes), the Buffer can
be expressed as an object

```json
{"type": "ams", "encoding": "base64", "data": "<base64>"}
```

### Example

```js
// Read 4 bytes from symbol 'MAIN.myVar'
msg.symbol = 'MAIN.myVar';
msg.readLength = 4;
return msg;
```

If you need to inject a frame manually:

```js
// Request frame as Buffer
const req = Buffer.from(
  '00003b00000006050403020153030102030405065303090004001b000000000000000100000003f0000000000000040000000b0000004d41494e2e6d7956617200',
  'hex'
);
msg.payload = req; // Buffer form
return msg;
```

The same frame encoded in Base64:

```json
{"type":"ams","encoding":"base64","data":"AAA7AAAABgUEAwIBUwMBAgMEBQZTAwkABAAbAAAAAAAAAAEAAAAD8AAAAAAAAAQAAAALAAAATUFJTi5teVZhcgA="}
```

An example response for the above request:

```json
{
  "type": "ams",
  "encoding": "base64",
  "data": "AAAsAAAAAQIDBAUGUwMGBQQDAgFTAwkABQAMAAAAAAAAAAEAAAAAAAAABAAAAHhWNBI="
}
```

The read node outputs the response data in `msg.payload` as a Buffer. The write
node forwards an empty Buffer on success. Both nodes include the `invokeId` and
ADS result code in the message.

## Development

1. Install dependencies

   ```bash
   npm install
   ```

2. Run tests

   ```bash
   npm test
   ```

3. Link the package into your local Node-RED instance during development:

   ```bash
   npm link
   ```

## License

MIT License

