# Third-party notices

Tinycode's own source is covered by [LICENSE](LICENSE). Dependencies and bundled third-party assets retain their own licenses and trademarks.

- **JetBrains Mono** is distributed under the SIL Open Font License 1.1. The [full license](public/assets/fonts/jetbrains-mono-LICENSE.txt) is included with the source and built UI. Font files come from `@fontsource-variable/jetbrains-mono`.
- **SF Pro** is referenced through the local system font stack. Tinycode does not bundle or redistribute Apple's fonts.
- **OpenAI, Claude, and Pi marks** identify their respective harness integrations. They belong to their respective owners and are not covered by Tinycode's MIT license. See [sources and attribution](src/client/assets/harnesses/README.md).
- **Pierre Trees and Diffs** power the workspace explorer. Both are Apache-2.0 licensed; Trees also includes MIT-licensed contributions from headless-tree. The [license and notices](public/assets/pierre-NOTICES.txt) ship with the built UI.
- JavaScript and native dependencies are installed from the versions recorded in `pnpm-lock.yaml`; their packages include their respective license notices. The harnesses and their services have their own terms.

The architecture and interface were informed by [bb](https://github.com/get-bb/bb), [Paseo](https://github.com/getpaseo/paseo), [T3 Code](https://github.com/pingdotgg/t3code), and the Codex app. The [reference study](docs/references.md) records those design influences.

Tinycode is an independent project and is not affiliated with or endorsed by the harness vendors.
