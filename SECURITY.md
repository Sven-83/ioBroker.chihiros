# Security Policy

## Supported versions

Only the latest state of the `main` branch is supported.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
(Security tab → "Report a vulnerability") of this repository. You will get an answer within 14 days.

## Known limitations

Chihiros devices use Bluetooth Low Energy without pairing or authentication. Anybody within radio
range can read and control them with the manufacturer app or a script; this adapter cannot change
that. The adapter only talks to the MAC addresses you configure and keeps the ESPHome proxy API
encrypted (Noise key stored encrypted in the instance configuration).
