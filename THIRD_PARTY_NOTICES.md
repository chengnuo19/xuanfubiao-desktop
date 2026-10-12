# Third-party notices

## Tokri

The temporary basket interaction and horizontal shake detector are based on Tokri:

- Source: https://github.com/jarusll/tokri
- License: MIT
- Copyright © 2025

The MIT License (MIT)

Copyright © 2025

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the “Software”), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## FloatBar Apps Always On Top

The web dock interaction and managed Picture-in-Picture window flow are based on FloatBar Apps
Always On Top:

- Source: https://github.com/devlogno/FloatBar-Always-on-Top
- License: MIT
- Copyright (c) 2026 Logno

MIT License

Copyright (c) 2026 Logno

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tabler Icons

The desktop UI icons are copied from Tabler Icons (outline set) by `tools/sync-icons.mjs`:

- Source: https://github.com/tabler/tabler-icons
- License: MIT

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## clawd-on-desk

编码代理的接入层（`packages/clawd-core/`：agents、hooks、宿主核心与权限气泡）原样复制自 clawd-on-desk，
由 `tools/sync-clawd.mjs` 同步，未做修改。悬浮标因此整体以 AGPL-3.0-only 发布（见根目录 LICENSE）。

- Source: https://github.com/rullerzhou-afk/clawd-on-desk
- Commit: 见 `packages/clawd-core/UPSTREAM.md`
- License: GNU Affero General Public License v3.0 only
- Copyright (c) clawd-on-desk contributors（@rullerzhou-afk 鹿鹿、@YOIMIYA66、@Bynlk 等）

clawd-on-desk 的角色美术（Clawd、Calico、Cloudling、Hash Sage、Whale-chan）**不在** AGPL 授权范围内，
本仓库不包含、也不分发其中任何素材。悬浮标只提供兼容其 `theme.json` 格式的加载器，
主题文件需用户自行放入本地主题目录，仅供个人使用。

clawd-on-desk 自身引用的第三方材料（Lobe Icons，MIT；Freesound 音效，CC0）见其仓库的 NOTICE.md；
本仓库未复制这些图标与音效。
