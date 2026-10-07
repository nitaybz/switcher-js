# Changelog

## 1.8.1

- Release all UDP discovery sockets together after an error and make listener closure idempotent.
- Share concurrent TCP connection attempts and discard connections completing after device closure.
- Release completed login error listeners instead of accumulating them on a persistent socket.
- Add offline socket and login lifecycle regression tests.

Validated offline: 9 regression tests on Node 22.23.1. Network and socket APIs are mocked; no customer devices were operated.
