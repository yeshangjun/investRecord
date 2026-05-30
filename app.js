const { createApp, ref, computed, onMounted } = Vue;

// ========== 数据库层 ==========
const db = new Dexie('InvestDB');
db.version(9).stores({
  fundFlows: '++id, from, to, amount, date',
  investBatches: '++id, date',
  returns: '++id, stockName, date'
});
// fundFlows: 资金转账流水（from转出人, to转入人, amount金额, date日期, remark备注）
// investBatches: 打新批次（stockName, stockPrice发行价, details[{person,amount,shares}], total总额, date日期）
// returns: 收益结算记录（sales[{person,shares,gain}], totalGain总收益, averageGain每万元收益, perPerson[{person,investment,gain,settlement}]）

createApp({
  setup() {
    const fundFlows = ref([]);
    const activeTab = ref('投资');
    const today = () => new Date().toISOString().slice(0, 10);
    const fundFlowForm = ref({ from: '金珠丹', to: '叶尚军', amount: null, date: today() });
    const selectedPerson = ref(null);
    const persons = ref(['金珠丹', '叶尚军', '陈屹', '邵霆']);
    const savedPersons = localStorage.getItem('investPersons');
    if (savedPersons) persons.value = JSON.parse(savedPersons);
    const savePersons = () => localStorage.setItem('investPersons', JSON.stringify(persons.value));

    // 投资表单状态
    const investForm = ref({ date: today(), stockName: '', stockPrice: null, amounts: persons.value.map(p => 0), shares: persons.value.map(p => 0) });
    const returnForm = ref({ date: today(), stockName: '', sales: [] });
    const returnRecords = ref([]);
    const investBatches = ref([]);
    const prevStockName = ref('');

    const totalInvestAmount = computed(() => investForm.value.amounts.reduce((s, a) => s + (a || 0), 0));
    const stockNameList = computed(() => [...new Set(investBatches.value.map(b => b.stockName).filter(Boolean))]);

    const selectedBatch = computed(() => investBatches.value.find(b => b.stockName === returnForm.value.stockName) || null);
    const stockPrice = computed(() => selectedBatch.value?.stockPrice || 0);
    const saleGains = computed(() => returnForm.value.sales.map(s => ({...s})));
    const totalGain = computed(() => returnForm.value.sales.reduce((s, r) => s + (r.gain || 0), 0));
    const totalInvestment = computed(() => selectedBatch.value?.total || 0);
    const averageGain = computed(() => totalInvestment.value ? totalGain.value / totalInvestment.value : 0);
    const personGainFromSales = (person) => returnForm.value.sales.filter(s => s.person === person).reduce((s, r) => s + (r.gain || 0), 0);
    const personReturns = computed(() => {
      if (!selectedBatch.value) return [];
      return selectedBatch.value.details.map(d => {
        return { person: d.person, investment: d.amount, gain: averageGain.value * d.amount, settlement: averageGain.value * d.amount - personGainFromSales(d.person) };
      });
    });

    // 导入解析弹窗状态
    const showImportModal = ref(false);
    const importUnknownNames = ref([]);
    const importPendingResolve = ref(null);

    const personFundRecords = computed(() => {
      const person = selectedPerson.value;
      if (!person) return [];
      const flows = fundFlows.value.filter(f => (f.from === person || f.to === person) && !(f.remark && f.remark.startsWith('北交打新:')));
      flows.sort((a, b) => new Date(a.date) - new Date(b.date));
      let balance = 0;
      const result = flows.map(f => {
        const isSelf = f.from === f.to;
        const isIn = f.to === person;
        const change = isSelf ? +f.amount : (isIn ? +Math.abs(f.amount) : -Math.abs(f.amount));
        balance += change;
        return {
          date: f.date,
          change,
          counterparty: isSelf ? null : (isIn ? f.from : f.to),
          isIn,
          isSelf,
          remark: f.remark || null,
          balance
        };
      });
      return result.reverse();
    });

    const loadFundFlows = async () => {
      fundFlows.value = await db.fundFlows.toArray();
      fundFlows.value.sort((a, b) => new Date(b.date) - new Date(a.date));
    };

    // 转账记录
    const addFundFlow = async () => {
      const { from, to, amount } = fundFlowForm.value;
      if (!amount) return alert('请填写金额');
      await db.fundFlows.add({
        from, to, amount, date: fundFlowForm.value.date
      });
      fundFlowForm.value = { from: '金珠丹', to: '叶尚军', amount: null, date: today() };
      await loadFundFlows();
    };
    const deleteFundFlow = async (id) => {
      if (!confirm('确认删除？')) return;
      await db.fundFlows.delete(id);
      await loadFundFlows();
    };

    // 修改转账记录
    const editingFundFlowId = ref(null);
    const editForm = ref({ from: '', to: '', date: '', amount: null, remark: '' });
    const toDateInput = (d) => {
      if (!d) return '';
      const parts = d.split('-');
      if (parts.length !== 3) return d;
      return `${parts[0].padStart(4, '0')}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    };
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
    const cancelEditFundFlow = () => {
      editingFundFlowId.value = null;
    };
    const saveEditFundFlow = async () => {
      const { from, to, date, amount, remark } = editForm.value;
      if (!amount) return alert('请填写金额');
      await db.fundFlows.update(editingFundFlowId.value, { from, to, date, amount, remark: remark || null });
      editingFundFlowId.value = null;
      await loadFundFlows();
    };

    // 导出转账记录 CSV
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

    // 导入转账记录 CSV
    const resolveName = (name) => {
      const found = importUnknownNames.value.find(u => u.name === name);
      if (!found || found.action === 'add') return { name };
      return { name: found.mergeTarget, remark: name };
    };

    const confirmImportResolve = () => {
      showImportModal.value = false;
      if (importPendingResolve.value) {
        importPendingResolve.value.resolve();
        importPendingResolve.value = null;
      }
    };

    const cancelImportResolve = () => {
      showImportModal.value = false;
      if (importPendingResolve.value) {
        importPendingResolve.value.reject();
        importPendingResolve.value = null;
      }
    };

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
        const dataLines = lines.slice(1);
        let records = dataLines.map(line => {
          const parts = line.split(',');
          if (parts.length < 4) return null;
          const [date, amountStr, from, to] = parts.map(s => s.trim());
          const amount = parseFloat(amountStr);
          if (isNaN(amount)) return null;
          return { date, amount, from, to };
        }).filter(Boolean);
        if (records.length === 0) return alert('未找到有效记录');

        const allNames = new Set(records.flatMap(r => [r.from, r.to]));
        const unknownNames = [...allNames].filter(n => !persons.value.includes(n));

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

        // 应用人名解析
        records = records.map(r => {
          const fromR = resolveName(r.from);
          const toR = resolveName(r.to);
          const remark = [fromR.remark, toR.remark].filter(Boolean).join('; ') || null;
          return { ...r, from: fromR.name, to: toR.name, remark };
        });

        // 新增人员持久化
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

    // 投资打新
    const onFocusStockName = () => {
      prevStockName.value = investForm.value.stockName;
      investForm.value.stockName = '';
    };
    const onBlurStockName = () => {
      if (!investForm.value.stockName) investForm.value.stockName = prevStockName.value;
    };

    const loadRecentInvest = (stockName) => {
      if (!stockName) return;
      const recent = investBatches.value.find(b => b.stockName === stockName);
      if (!recent) {
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

    const submitInvest = async () => {
      const { date, stockName, stockPrice, amounts, shares } = investForm.value;
      if (!stockName) return alert('请输入新股名称/代码');
      const details = persons.value.map((p, i) => ({ person: p, amount: amounts[i] || 0, shares: shares[i] || 0 })).filter(d => d.amount > 0);
      if (details.length === 0) return alert('请填写投资金额');
      const total = details.reduce((s, d) => s + d.amount, 0);

      const existing = investBatches.value.find(b => b.stockName === stockName);
      if (existing) {
        await db.investBatches.update(existing.id, { date, stockPrice, details, total });
        const allFlows = await db.fundFlows.toArray();
        const oldIds = allFlows.filter(f => f.remark === `北交打新: ${stockName}`).map(f => f.id);
        if (oldIds.length) await db.fundFlows.bulkDelete(oldIds);
      } else {
        await db.investBatches.add({ date, stockName, stockPrice, details, total });
      }
      for (const d of details) {
        await db.fundFlows.add({ from: d.person, to: d.person, amount: d.amount, date, remark: `北交打新: ${stockName}` });
      }
      investForm.value = { date: today(), stockName: '', stockPrice: null, amounts: persons.value.map(p => 0), shares: persons.value.map(p => 0) };
      await Promise.all([loadInvestBatches(), loadFundFlows()]);
    };

    const deleteInvestBatch = async (id) => {
      if (!confirm('确认删除？')) return;
      await db.investBatches.delete(id);
      await loadInvestBatches();
    };

    const addSaleRow = () => { returnForm.value.sales.push({ person: '', shares: 0, gain: 0 }); };
    const removeSaleRow = (i) => { returnForm.value.sales.splice(i, 1); };
    const getPersonShares = (person) => {
      if (!selectedBatch.value) return 0;
      const d = selectedBatch.value.details.find(r => r.person === person);
      return d ? d.shares || 0 : 0;
    };
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
    const deleteReturnRecord = async (id) => {
      if (!confirm('确认删除？')) return;
      await db.returns.delete(id);
      await loadReturnRecords();
    };
    const loadReturnRecords = async () => {
      returnRecords.value = await db.returns.toArray();
      returnRecords.value.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);
    };

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

    onMounted(async () => {
      await Promise.all([loadFundFlows(), loadInvestBatches(), loadReturnRecords()]);
      await renameInDB('刘慧', '叶尚军');
      await Promise.all([loadFundFlows(), loadInvestBatches(), loadReturnRecords()]);
    });

    return { fundFlows, deleteFundFlow, activeTab, fundFlowForm, addFundFlow, persons, selectedPerson, personFundRecords, exportFundFlows, importFundFlows, showImportModal, importUnknownNames, confirmImportResolve, cancelImportResolve, editingFundFlowId, editForm, startEditFundFlow, cancelEditFundFlow, saveEditFundFlow, investForm, investBatches, totalInvestAmount, stockNameList, submitInvest, deleteInvestBatch, loadRecentInvest, onFocusStockName, onBlurStockName, returnForm, returnRecords, selectedBatch, stockPrice, saleGains, totalGain, totalInvestment, averageGain, personReturns, addSaleRow, removeSaleRow, getPersonShares, onReturnStockChange, submitReturn, deleteReturnRecord };
  }
}).mount('#app');