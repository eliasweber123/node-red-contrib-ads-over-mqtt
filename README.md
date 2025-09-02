# node-red-contrib-ads-over-mqtt

This repository provides a set of [Node-RED](https://nodered.org/) nodes for
communicating with Beckhoff TwinCAT ADS devices over an MQTT broker. The nodes
are intended as a starting point for building flows that read from and write to
ADS symbols using MQTT messages.

## Nodes

- **ads-client-connection** – configuration node that establishes the MQTT
  connection and holds AMS routing parameters.
- **ads-client-read-symbol** – reads the value of a given ADS symbol. The symbol
  can be configured in the node or supplied as `msg.symbol`.
- **ads-client-write-symbol** – writes a value from `msg.payload` to the
  specified ADS symbol.

These nodes publish and subscribe to the following MQTT topics:

- `ads/read` – request a symbol value
- `ads/write` – write a symbol value
- `ads/response` – responses for read requests

The exact wire protocol may be adapted to suit the ADS-over-MQTT gateway you
are using.

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

