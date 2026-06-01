# 北交打新记账本

Client-side new-stock (北交所打新) investment tracking PWA (Vue 3 + Tailwind + Dexie/IndexedDB).
No build step, no backend, no package.json, no tests.

## Commit convention

代码修改后不立即 commit，仅在版本号更新时统一 commit 并 push。版本号在 app.js 的 `version` 变量中管理，格式 `major.minor.patch`。

## Quick start

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

## Architecture

- **`index.html`** — single-page entrypoint. CDN deps: Vue 3, Tailwind CSS, Dexie 3.
- **`app.js`** — all app logic. Vue 3 Options API (`createApp` + `setup()`), Dexie for persistence.
- **`manifest.json`** — PWA manifest. No service worker file; relies on browser default.
- No routing, no API, no build. All data local-only in IndexedDB.
- Tab names (Chinese strings): `投资, 转账记录, 资金记录, 收益`. Template uses strict equality (`v-if="activeTab==='转账记录'"`) — don't rename without updating all switches.

## Database

IndexedDB via Dexie (`InvestDB`, version 9):

- **`fundFlows`** — transfer records: `++id, from, to, amount, date`. The `remark` field (for merge tracking) is stored on records but not indexed.
- **`investBatches`** — new-stock investment batches: `++id, date`. Each batch stores `date`, `stockName`, `stockPrice`, `details` (array of `{person, amount, shares}`), and `total`.
- **`returns`** — return/profit records: `++id, stockName, date`. Each record stores `stockName`, `date`, `sales` (array of `{person, shares, amount, gain}`), `totalGain`, `totalInvestment`, `averageGain`, and `perPerson` (array of `{person, investment, gain, accountFund, settlement}`).

## State & conventions

- **收益 (Returns)** tab: date + stock name dropdown + per-sale rows (person, shares, gain, auto-calculated gain) + summary (total gain, total investment, average gain) + per-person profit allocation with accountFund input and settlement calculation. Submits to `returns` table.
- **投资** tab: date + stock name + stock unit price + per-person amount + shares inputs. Entering a stock name auto-fills from the most recent batch for that stock. Shares use step-by-100 buttons. Submitting creates/updates an `investBatches` record and self-transfer `fundFlow` records per person (remark: `北交打新: <stockName>`). If the stock name already exists, the batch is updated (old fundFlows for that stock are deleted and recreated).
- Four default persons: `金珠丹, 叶尚军, 陈屹, 邵霆`. Persons list is persisted in `localStorage` (`investPersons`) and can grow via CSV import.
- Transfer form defaults reset to `{ from: '金珠丹', to: '叶尚军', ... }` after submit.
- `from === to` is allowed — treated as **本金增加** (capital injection) for that person.
- **资金记录** tab is a computed view on `fundFlows`: sorts ascending by `date`/`time`, computes running balance. Self-transfers use raw signed amount; cross-person transfers use `Math.abs` with direction from `from`/`to`.
- All amounts are in **万元 (10k CNY)** — investment prices are not, only transfer/fund amounts.
- `selectedPerson` is `null` on first visit; user must tap a person button to see fund records.
- Import/export CSV (转账记录 tab): format `日期,金额,转出人,转入人`. Import uses `Math.abs(amount)`, skips header row, prompts whether to clear existing records. If CSV contains names not in the persons list, a modal prompts to **add** them or **merge** into an existing person (merge creates a `remark` field on the record). Export includes BOM for Excel compatibility.
- The `remark` field is displayed in both 转账记录 and 资金记录 tabs when present.

## Todo List

| 优先级 | 状态 | 功能 | 说明 |
|--------|------|------|------|
| medium | done | 数据库整体导入导出功能（JSON 格式） | 将 fundFlows / investBatches / returns 三张表整体导出为 JSON 备份，支持从备份恢复 |
| medium | done | 版本号功能 | 头部标题右侧显示版本号，点击弹出 readme.txt 说明 |
