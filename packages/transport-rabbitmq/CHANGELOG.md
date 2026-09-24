# @tnet06/mapa-audit-transport-rabbitmq

## 0.1.0

### Initial release

- Added `RabbitMQTransport`.
- Added configurable publishing through exchange and routing key.
- Added visible connection and publish failure warnings.
- Added configurable publish timeout handling.
- Added pass-through `connectionOptions`.
- Decoupled the public `connectionOptions` type from internal
  `amqp-connection-manager` types.
