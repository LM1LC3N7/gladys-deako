# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Deako smart switches and dimmers through the local API of the Deako Connect
  (TCP port 23, ported from pydeako 0.6.0 and the Deako local-integrations
  documentation, both MIT, by Deako): power and brightness, the changes made at
  the wall or in the app shown at once, a full read every poll interval.
- Offs (power 0, brightness 0) protective: never held back by a command or a
  read in flight, the 800 ms gap, a failed connection or the configuration not
  read yet; kept in `/data` and sent again until the device shows them.
- A scene on many lights sets every light (one message every 800 ms, those of
  one device merged while waiting).
- "Test the connection" button, Discover, connection status in English and
  French, user documentation.
