const { createApp, ref, computed, onMounted } = Vue;

// ========== 数据库层（IndexedDB via Dexie） ==========
// 数据库名：InvestDB，版本 9
const db = new Dexie('InvestDB');
db.version(9).stores({
  fundFlows: '++id, from, to, amount, date',    // 资金转账流水（from转出人, to转入人, amount金额, date日期, remark备注）
  investBatches: '++id, date',                   // 打新批次（stockName股票名, stockPrice发行价, details[{person,amount,shares}], total总额, date日期）
  returns: '++id, stockName, date'               // 收益结算记录（sales[{person,shares,gain}], totalGain总收益, averageGain每万元收益, perPerson[{person,investment,gain,settlement}]）
});

createApp({
  setup() {

    // ========== 全局状态 ==========
    const version = '1.1.2';                                  // 当前版本号
    const showVersionModal = ref(false);                      // 版本说明弹窗显示状态
    const versionInfo = ref('');                              // 版本说明文本内容
    const fundFlows = ref([]);                               // 所有转账记录（内存缓存）
    const activeTab = ref('转账记录');                       // 当前激活的 tab
    const today = () => new Date().toISOString().slice(0, 10);  // 返回今天日期字符串 YYYY-MM-DD

    // 转账表单：默认从金珠丹转给叶尚军
    const fundFlowForm = ref({ from: '金珠丹', to: '叶尚军', amount: null, date: today(), remark: '' });

    // 资金记录 tab：选中的查看对象，null 表示未选择任何人
    const selectedPerson = ref(null);

    // 人员列表：默认四人，持久化到 localStorage
    const persons = ref(['金珠丹', '叶尚军', '陈屹', '邵霆']);
    const savedPersons = localStorage.getItem('investPersons');
    if (savedPersons) persons.value = JSON.parse(savedPersons);
    const savePersons = () => localStorage.setItem('investPersons', JSON.stringify(persons.value));

    // ========== 投资表单状态 ==========
    // date 日期；stockName 股票名；stockPrice 发行价；amounts 每人投资金额；shares 每人中签股数
    const investForm = ref({ date: today(), stockName: '', stockPrice: null, amounts: persons.value.map(p => 0), shares: persons.value.map(p => 0) });

    // ========== 收益表单状态 ==========
    // date 日期；stockName 股票名（下拉选择已存在股票）；sales 卖出记录列表 [{person, shares, gain}]
    const returnForm = ref({ date: today(), stockName: '', sales: [] });
    const returnRecords = ref([]);                           // 已提交的收益记录列表
    const investBatches = ref([]);                          // 所有打新批次
    const prevStockName = ref('');                          // 投资 tab 的股票名输入回退用（datalist 交互）

    // ========== 计算属性 ==========
    // 当前投资表单的总金额（展示用）
    const totalInvestAmount = computed(() => investForm.value.amounts.reduce((s, a) => s + (a || 0), 0));

    // 从所有打新批次提取不重复的股票名列表（去重），供两个 tab 的下拉框使用
    const stockNameList = computed(() => [...new Set(investBatches.value.map(b => b.stockName).filter(Boolean))]);

    // 收益 tab：当前选中的股票对应的打新批次（用于填充卖出表单和计算人均）
    const selectedBatch = computed(() => investBatches.value.find(b => b.stockName === returnForm.value.stockName) || null);

    // 收益 tab：选中批次的发行价
    const stockPrice = computed(() => selectedBatch.value?.stockPrice || 0);

    // 收益 tab：卖出记录浅拷贝（用于提交时序列化，避免直接修改响应式对象）
    const saleGains = computed(() => returnForm.value.sales.map(s => ({...s})));

    // 收益 tab：所有卖出收益的总和
    const totalGain = computed(() => returnForm.value.sales.reduce((s, r) => s + (r.gain || 0), 0));

    // 收益 tab：选中批次的总投资额（万元）
    const totalInvestment = computed(() => selectedBatch.value?.total || 0);

    // 收益 tab：每万元收益 = 总收益 / 总投资额（避免除以 0）
    const averageGain = computed(() => totalInvestment.value ? totalGain.value / totalInvestment.value : 0);

    // 计算某人在所有卖出行中收益之和（用于结算公式）
    const personGainFromSales = (person) => returnForm.value.sales.filter(s => s.person === person).reduce((s, r) => s + (r.gain || 0), 0);

    // 收益 tab：每人结算明细 [投资者, 投资金额, 收益, 结算]
    // 收益 = averageGain × 投资额；结算 = 收益 − 该人卖出收益总和
    const personReturns = computed(() => {
      if (!selectedBatch.value) return [];
      return selectedBatch.value.details.map(d => {
        return { person: d.person, investment: d.amount, gain: averageGain.value * d.amount, settlement: averageGain.value * d.amount - personGainFromSales(d.person) };
      });
    });

    // ========== 导入解析弹窗状态 ==========
    // 当 CSV 中出现人员列表中不存在的名字时，弹出模态框让用户选择"新增"或"合并到已有人员"
    const showImportModal = ref(false);
    const importUnknownNames = ref([]);                     // 不认识的名字列表 [{name, action, mergeTarget}]
    const importPendingResolve = ref(null);                 // Promise 的 resolve/reject 用于等待弹窗确认

    // ========== 资金记录计算 ==========
    // 根据 selectedPerson 筛选该人的转账记录并计算累计余额
    // 排除北交打新的自转账记录（remark 以'北交打新:'开头）
    const personFundRecords = computed(() => {
      const person = selectedPerson.value;
      if (!person) return [];
      const flows = fundFlows.value.filter(f => (f.from === person || f.to === person) && !(f.remark && f.remark.startsWith('北交打新:')));
      flows.sort((a, b) => new Date(a.date) - new Date(b.date));  // 从旧到新，便于累加余额
      let balance = 0;
      const result = flows.map(f => {
        const isSelf = f.from === f.to;                     // 是否自转账（本金增减）
        const isIn = f.to === person;                        // 是否转入
        // 自转用原始符号；跨人转用绝对值，转入为正转出为负
        const change = isSelf ? +f.amount : (isIn ? +Math.abs(f.amount) : -Math.abs(f.amount));
        balance += change;
        return {
          date: f.date,
          change,                                          // 金额变动
          counterparty: isSelf ? null : (isIn ? f.from : f.to),  // 对方
          isIn,                                            // 是否转入
          isSelf,                                          // 是否自转
          remark: f.remark || null,
          balance                                          // 累计余额
        };
      });
      return result.reverse();                             // 反转为从新到旧展示
    });

    // ========== 数据加载函数 ==========
    // 从 IndexedDB 加载转账记录，按日期降序（最新的在前）
    const loadFundFlows = async () => {
      fundFlows.value = await db.fundFlows.toArray();
      fundFlows.value.sort((a, b) => new Date(b.date) - new Date(a.date));
    };

    // ========== 转账记录 CRUD ==========
    // 添加转账记录
    const addFundFlow = async () => {
      const { from, to, amount, remark } = fundFlowForm.value;
      if (!amount) return alert('请填写金额');
      const record = { from, to, amount, date: fundFlowForm.value.date };
      if (remark) record.remark = remark;
      await db.fundFlows.add(record);
      // 重置表单默认值（从金珠丹→叶尚军）
      fundFlowForm.value = { from: '金珠丹', to: '叶尚军', amount: null, date: today(), remark: '' };
      await loadFundFlows();
    };

    // 删除转账记录
    const deleteFundFlow = async (id) => {
      if (!confirm('确认删除？')) return;
      await db.fundFlows.delete(id);
      await loadFundFlows();
    };

    // ========== 转账记录行内编辑 ==========
    const editingFundFlowId = ref(null);                    // 当前正在编辑的记录 id，null 表示无编辑
    const editForm = ref({ from: '', to: '', date: '', amount: null, remark: '' });  // 编辑弹窗绑定的表单数据

    // 将 '2026-5-27' 补零为 '2026-05-27'，适配 <input type="date">
    const toDateInput = (d) => {
      if (!d) return '';
      const parts = d.split('-');
      if (parts.length !== 3) return d;
      return `${parts[0].padStart(4, '0')}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    };

    // 点击编辑按钮，开始行内编辑
    const startEditFundFlow = (item) => {
      editingFundFlowId.value = item.id;
      editForm.value = {
        from: item.from,
        to: item.to,
        date: toDateInput(item.date),
        amount: item.amount,
        remark: item.remark || ''
      };
    };

    // 取消编辑
    const cancelEditFundFlow = () => {
      editingFundFlowId.value = null;
    };

    // 保存编辑
    const saveEditFundFlow = async () => {
      const { from, to, date, amount, remark } = editForm.value;
      if (!amount) return alert('请填写金额');
      await db.fundFlows.update(editingFundFlowId.value, { from, to, date, amount, remark: remark || null });
      editingFundFlowId.value = null;
      await loadFundFlows();
    };

    // ========== 导出转账记录 CSV ==========
    // 生成 UTF-8 BOM（\uFEFF）使 Excel 正确识别中文
    const exportFundFlows = async () => {
      const flows = await db.fundFlows.toArray();
      const header = '日期,金额,转出人,转入人';
      const rows = flows.map(f => `${f.date || ''},${f.amount},${f.from},${f.to}`);
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `转账记录_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };

    // ========== 导入转账记录 CSV ==========
    // CSV 格式：日期,金额,转出人,转入人（第一行是表头）
    // 不认识的人名会弹出模态框让用户选择：新增为正式人员 或 合并到已有人员（remark 记录原名）
    const resolveName = (name) => {
      const found = importUnknownNames.value.find(u => u.name === name);
      if (!found || found.action === 'add') return { name };        // 新增：直接用原名
      return { name: found.mergeTarget, remark: name };           // 合并：remark 记录原名
    };

    // 用户在弹窗中确认了名称解析方案
    const confirmImportResolve = () => {
      showImportModal.value = false;
      if (importPendingResolve.value) {
        importPendingResolve.value.resolve();
        importPendingResolve.value = null;
      }
    };

    // 用户在弹窗中取消了导入
    const cancelImportResolve = () => {
      showImportModal.value = false;
      if (importPendingResolve.value) {
        importPendingResolve.value.reject();
        importPendingResolve.value = null;
      }
    };

    // 执行 CSV 导入
    const importFundFlows = async () => {
      const clearFirst = confirm('是否清空当前记录？');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        const dataLines = lines.slice(1);                        // 跳过表头
        let records = dataLines.map(line => {
          const parts = line.split(',');
          if (parts.length < 4) return null;
          const [date, amountStr, from, to] = parts.map(s => s.trim());
          const amount = parseFloat(amountStr);
          if (isNaN(amount)) return null;
          return { date, amount, from, to };
        }).filter(Boolean);
        if (records.length === 0) return alert('未找到有效记录');

        // 检查是否有不认识的人名
        const allNames = new Set(records.flatMap(r => [r.from, r.to]));
        const unknownNames = [...allNames].filter(n => !persons.value.includes(n));

        // 有不认识的名字，弹出模态框等待用户决策
        if (unknownNames.length > 0) {
          try {
            await new Promise((resolve, reject) => {
              importPendingResolve.value = { resolve, reject };
              importUnknownNames.value = unknownNames.map(n => ({ name: n, action: 'add', mergeTarget: persons.value[0] }));
              showImportModal.value = true;
            });
          } catch {
            importUnknownNames.value = [];
            return;
          }
        }

        // 应用人名解析（新增或合并）
        records = records.map(r => {
          const fromR = resolveName(r.from);
          const toR = resolveName(r.to);
          const remark = [fromR.remark, toR.remark].filter(Boolean).join('; ') || null;
          return { ...r, from: fromR.name, to: toR.name, remark };
        });

        // 新增人员持久化到 localStorage
        const newPersons = importUnknownNames.value.filter(u => u.action === 'add').map(u => u.name);
        if (newPersons.length > 0) {
          newPersons.forEach(n => { if (!persons.value.includes(n)) persons.value.push(n); });
          savePersons();
        }

        importUnknownNames.value = [];
        if (clearFirst) await db.fundFlows.clear();
        await db.fundFlows.bulkAdd(records);
        await loadFundFlows();
      };
      input.click();
    };

    // ========== 数据库整体导出/导入 ==========
    // 导出：将三张表数据序列化为 JSON 文件下载
    const exportDB = async () => {
      const [fundFlowsData, investBatchesData, returnsData] = await Promise.all([
        db.fundFlows.toArray(),
        db.investBatches.toArray(),
        db.returns.toArray()
      ]);
      const data = {
        version: 9,
        exportedAt: new Date().toISOString(),
        fundFlows: fundFlowsData,
        investBatches: investBatchesData,
        returns: returnsData
      };
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `数据库备份_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };

    // 数据库导入弹窗状态
    const showDbImportModal = ref(false);
    const dbImportStats = ref({ fundFlows: 0, investBatches: 0, returns: 0 });
    const pendingDbImportData = ref(null);

    // 取消数据库导入
    const cancelDbImport = () => {
      showDbImportModal.value = false;
      pendingDbImportData.value = null;
    };

    // 确认导入数据库
    const confirmDbImport = async () => {
      if (!pendingDbImportData.value) return;
      const raw = pendingDbImportData.value;
      const fundFlows = JSON.parse(JSON.stringify(raw.fundFlows));
      const investBatches = JSON.parse(JSON.stringify(raw.investBatches));
      const returns = JSON.parse(JSON.stringify(raw.returns));
      await db.fundFlows.clear();
      await db.investBatches.clear();
      await db.returns.clear();
      if (fundFlows.length) await db.fundFlows.bulkAdd(fundFlows);
      if (investBatches.length) await db.investBatches.bulkAdd(investBatches);
      if (returns.length) await db.returns.bulkAdd(returns);
      showDbImportModal.value = false;
      pendingDbImportData.value = null;
      await Promise.all([loadFundFlows(), loadInvestBatches(), loadReturnRecords()]);
    };

    // 导入数据库 JSON 文件
    const importDB = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return alert('文件格式错误，无法解析 JSON');
        }
        if (!data.version || !data.fundFlows || !data.investBatches || !data.returns) {
          return alert('文件格式错误，缺少必要字段');
        }
        dbImportStats.value = {
          fundFlows: data.fundFlows.length,
          investBatches: data.investBatches.length,
          returns: data.returns.length
        };
        // 深拷贝以剥离 Vue 响应式代理，避免 IndexedDB structured clone 失败
        pendingDbImportData.value = JSON.parse(JSON.stringify(data));
        showDbImportModal.value = true;
      };
      input.click();
    };

    // ========== 投资打新 ==========
    // 股票名输入框聚焦时清空，以显示 datalist 所有选项
    const onFocusStockName = () => {
      prevStockName.value = investForm.value.stockName;
      investForm.value.stockName = '';
    };

    // 失焦时如果用户未输入则恢复原值
    const onBlurStockName = () => {
      if (!investForm.value.stockName) investForm.value.stockName = prevStockName.value;
    };

    // 根据股票名从历史批次中加载发行价、日期、每人金额和股数
    const loadRecentInvest = (stockName) => {
      if (!stockName) return;
      const recent = investBatches.value.find(b => b.stockName === stockName);
      if (!recent) {
        // 未找到历史批次，清空单价和金额
        investForm.value.stockPrice = null;
        investForm.value.amounts = persons.value.map(() => 0);
        investForm.value.shares = persons.value.map(() => 0);
        return;
      }
      investForm.value.stockPrice = recent.stockPrice || null;
      investForm.value.date = recent.date || today();
      investForm.value.amounts = persons.value.map(p => {
        const d = recent.details.find(r => r.person === p);
        return d ? d.amount : 0;
      });
      investForm.value.shares = persons.value.map(p => {
        const d = recent.details.find(r => r.person === p);
        return d ? d.shares || 0 : 0;
      });
    };

    // 从 IndexedDB 加载打新批次，按日期降序排列，同一天按 id 倒序
    // 并用最近一条批次填充投资表单默认值
    const loadInvestBatches = async () => {
      const batches = await db.investBatches.toArray();
      batches.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);
      investBatches.value = batches;
      if (investBatches.value.length > 0) {
        const last = investBatches.value[0];
        investForm.value = {
          date: last.date || today(),
          stockName: last.stockName || '',
          stockPrice: last.stockPrice || null,
          amounts: persons.value.map(p => { const d = last.details.find(r => r.person === p); return d ? d.amount : 0; }),
          shares: persons.value.map(p => { const d = last.details.find(r => r.person === p); return d ? d.shares || 0 : 0; })
        };
      }
    };

    // 提交投资打新记录
    // 股票名已存在则更新批次，不存在则新建
    const submitInvest = async () => {
      const { date, stockName, stockPrice, amounts, shares } = investForm.value;
      if (!stockName) return alert('请输入新股名称/代码');
      // 构建 details：过滤掉金额为 0 的人
      const details = persons.value.map((p, i) => ({ person: p, amount: amounts[i] || 0, shares: shares[i] || 0 })).filter(d => d.amount > 0);
      if (details.length === 0) return alert('请填写投资金额');
      const total = details.reduce((s, d) => s + d.amount, 0);

      const existing = investBatches.value.find(b => b.stockName === stockName);
      if (existing) {
        await db.investBatches.update(existing.id, { date, stockPrice, details, total });
      } else {
        await db.investBatches.add({ date, stockName, stockPrice, details, total });
      }
      // 重置表单
      investForm.value = { date: today(), stockName: '', stockPrice: null, amounts: persons.value.map(p => 0), shares: persons.value.map(p => 0) };
      await loadInvestBatches();
    };

    // 删除打新批次记录
    const deleteInvestBatch = async (id) => {
      if (!confirm('确认删除？')) return;
      await db.investBatches.delete(id);
      await loadInvestBatches();
    };

    // ========== 收益 tab ==========
    // 添加一条空卖出记录行
    const addSaleRow = () => { returnForm.value.sales.push({ person: '', shares: 0, gain: 0 }); };

    // 删除第 i 条卖出记录
    const removeSaleRow = (i) => { returnForm.value.sales.splice(i, 1); };

    // 获取某人在选中批次中的中签股数（作为卖出时的上限提示）
    const getPersonShares = (person) => {
      if (!selectedBatch.value) return 0;
      const d = selectedBatch.value.details.find(r => r.person === person);
      return d ? d.shares || 0 : 0;
    };

    // 收益 tab 股票下拉变更时：
    // - 如果该股票已有收益记录，加载历史卖出数据
    // - 否则从选中批次自动生成卖出初始行（每人一行，股数对应中签数）
    const onReturnStockChange = () => {
      const prev = returnRecords.value.find(r => r.stockName === returnForm.value.stockName);
      if (prev) {
        returnForm.value.sales = prev.sales.map(s => ({ person: s.person, shares: s.shares, gain: s.gain }));
        returnForm.value.date = prev.date;
      } else {
        returnForm.value.sales = [];
        if (selectedBatch.value) {
          returnForm.value.sales = selectedBatch.value.details.map(d => ({ person: d.person, shares: d.shares || 0, gain: 0 }));
        }
      }
    };

    // 提交收益记录（upsert by stockName）
    const submitReturn = async () => {
      const { date, stockName, sales } = returnForm.value;
      if (!stockName) return alert('请选择新股名称');
      if (!sales.length) return alert('请添加卖出记录');
      const existing = await db.returns.where('stockName').equals(stockName).first();
      const data = { date, stockName, sales: saleGains.value, totalGain: totalGain.value, totalInvestment: totalInvestment.value, averageGain: averageGain.value, perPerson: personReturns.value };
      if (existing) {
        await db.returns.update(existing.id, data);
      } else {
        await db.returns.add(data);
      }
      returnForm.value = { date: today(), stockName: '', sales: [] };
      await loadReturnRecords();
    };

    // 删除收益记录
    const deleteReturnRecord = async (id) => {
      if (!confirm('确认删除？')) return;
      await db.returns.delete(id);
      await loadReturnRecords();
    };

    // 加载收益记录列表，按日期降序排列
    const loadReturnRecords = async () => {
      returnRecords.value = await db.returns.toArray();
      returnRecords.value.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);
    };

    // ========== 一次性数据库迁移：人员改名 ==========
    // 将旧名字批量替换为新名字，执行一次后通过 localStorage 标记避免重复执行
    // 遍历 fundFlows（from/to）、investBatches（details.person）、returns（sales.person / perPerson.person）
    const renameInDB = async (fromName, toName) => {
      const key = `rename_${fromName}_to_${toName}`;
      if (localStorage.getItem(key)) return;
      const allFundFlows = await db.fundFlows.toArray();
      for (const f of allFundFlows) {
        if (f.from === fromName || f.to === fromName) {
          await db.fundFlows.update(f.id, { from: f.from === fromName ? toName : f.from, to: f.to === fromName ? toName : f.to });
        }
      }
      const allBatches = await db.investBatches.toArray();
      for (const b of allBatches) {
        let changed = false;
        const details = b.details.map(d => { if (d.person === fromName) { changed = true; return { ...d, person: toName }; } return d; });
        if (changed) await db.investBatches.update(b.id, { details });
      }
      const allReturns = await db.returns.toArray();
      for (const r of allReturns) {
        let changed = false;
        const sales = r.sales.map(s => { if (s.person === fromName) { changed = true; return { ...s, person: toName }; } return s; });
        const perPerson = r.perPerson.map(p => { if (p.person === fromName) { changed = true; return { ...p, person: toName }; } return p; });
        if (changed) await db.returns.update(r.id, { sales, perPerson });
      }
      localStorage.setItem(key, '1');
    };

    // ========== 版本说明弹窗 ==========
    // 点击版本号按钮时读取 readme.txt 内容并弹出说明
    const showVersionInfo = async () => {
      try {
        const resp = await fetch('./readme.txt');
        versionInfo.value = await resp.text();
      } catch {
        versionInfo.value = '无法读取说明文件';
      }
      showVersionModal.value = true;
    };

    // ========== 页面初始化 ==========
    onMounted(async () => {
      // 首次加载：从 IndexedDB 读取三张表数据
      await Promise.all([loadFundFlows(), loadInvestBatches(), loadReturnRecords()]);
      // 执行人员改名迁移（刘慧 → 叶尚军），通过 localStorage 标记确保只跑一次
      await renameInDB('刘慧', '叶尚军');
      // 迁移完成后重新加载数据（保证界面显示正确的名字）
      await Promise.all([loadFundFlows(), loadInvestBatches(), loadReturnRecords()]);
    });

    // ========== 模板导出 ==========
    // setup() 返回的所有变量和函数将暴露给 index.html 中的模板表达式
    return {
      fundFlows,
      deleteFundFlow,
      activeTab,
      fundFlowForm,
      addFundFlow,
      persons,
      selectedPerson,
      personFundRecords,
      exportFundFlows,
      importFundFlows,
      showImportModal,
      importUnknownNames,
      confirmImportResolve,
      cancelImportResolve,
      editingFundFlowId,
      editForm,
      startEditFundFlow,
      cancelEditFundFlow,
      saveEditFundFlow,
      investForm,
      investBatches,
      totalInvestAmount,
      stockNameList,
      submitInvest,
      deleteInvestBatch,
      loadRecentInvest,
      onFocusStockName,
      onBlurStockName,
      returnForm,
      returnRecords,
      selectedBatch,
      stockPrice,
      saleGains,
      totalGain,
      totalInvestment,
      averageGain,
      personReturns,
      addSaleRow,
      removeSaleRow,
      getPersonShares,
      onReturnStockChange,
      submitReturn,
      deleteReturnRecord,
      exportDB,
      importDB,
      showDbImportModal,
      dbImportStats,
      cancelDbImport,
      confirmDbImport,
      version,
      showVersionInfo,
      showVersionModal,
      versionInfo
    };
  }
}).mount('#app');