(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'weighbridge120t.records.v1';
  const SETTINGS_KEY = 'weighbridge120t.settings.v1';
  const CAPACITY = 120000;
  let records = readJSON(STORAGE_KEY, []);
  let settings = readJSON(SETTINGS_KEY, { systemName: 'Weighbridge 120T' });
  let liveWeight = 25660;
  let isStable = true;
  let firstCapture = null;
  let secondCapture = null;
  let activeRecord = null;
  let toastTimer = null;
  let serialPort = null;
  let serialReader = null;
  let serialReading = false;

  function readJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; }
  }
  function saveRecords() { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); renderAll(); }
  function fmt(value) { return Number(value || 0).toLocaleString('en-US'); }
  function now() { return new Date(); }
  function stamp(date = now()) { return date.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }); }
  function dateKey(date) { return date.toISOString().slice(0,10); }
  function ticketNo() { return 'WB-' + now().getFullYear() + '-' + String(Date.now()).slice(-6); }
  function showToast(message) {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }
  function setWeight(value) {
    liveWeight = Math.max(0, Math.min(CAPACITY, Math.round(Number(value) * 100) / 100));
    $('liveWeight').innerHTML = fmt(liveWeight) + '<span>كجم</span>';
    $('weightSlider').value = liveWeight;
    $('sliderValue').textContent = fmt(liveWeight) + ' كجم';
    const percent = liveWeight / CAPACITY * 100;
    $('capacityFill').style.width = percent + '%';
    $('capacityPercent').textContent = percent.toFixed(2) + '% من السعة';
    if (percent >= 95) $('capacityFill').style.background = 'linear-gradient(90deg,#d58a3d,#f0b54e)';
    else $('capacityFill').style.background = 'linear-gradient(90deg,#159b92,#52e0ce)';
  }
  function setStability(value) {
    isStable = value;
    const el = $('stableIndicator');
    el.classList.toggle('unstable', !isStable);
    el.innerHTML = '<i></i> ' + (isStable ? 'وزن مستقر' : 'الوزن متغير');
    $('toggleStability').textContent = isStable ? 'جعل الوزن متغيرًا' : 'تثبيت الوزن';
  }
  function capture() {
    if (!isStable) { $('formMessage').textContent = 'لا يمكن تسجيل الوزن قبل استقرار القراءة.'; return; }
    if (liveWeight > CAPACITY) { $('formMessage').textContent = 'الوزن يتجاوز السعة القصوى.'; return; }
    const plate = $('plateInput').value.trim();
    if (!plate) { $('formMessage').textContent = 'اكتب رقم السيارة أولًا.'; $('plateInput').focus(); return; }
    const captureData = { weight: liveWeight, time: now().toISOString() };
    if (!firstCapture) {
      firstCapture = captureData;
      $('formMessage').textContent = 'تم تسجيل الوزنة الأولى. سجّل الوزنة الثانية بعد تغيير قراءة الميزان.';
      updateCaptureUI();
      showToast('تم تسجيل الوزنة الأولى');
      return;
    }
    if (!secondCapture) {
      secondCapture = captureData;
      const net = Math.abs(firstCapture.weight - secondCapture.weight);
      const record = {
        id: ticketNo(), plate, driver: $('driverInput').value.trim() || '—',
        customer: $('customerInput').value.trim() || '—',
        firstWeight: firstCapture.weight, secondWeight: secondCapture.weight,
        netWeight: net, firstTime: firstCapture.time, secondTime: secondCapture.time,
        createdAt: now().toISOString(), source: serialPort ? 'RS232 / USB Serial' : 'SIMULATOR'
      };
      records.unshift(record); activeRecord = record; saveRecords();
      $('formMessage').textContent = 'اكتملت عملية الوزن وحُفظت التذكرة بنجاح.';
      updateCaptureUI(); showToast('تم حفظ التذكرة ' + record.id); openTicket(record);
      return;
    }
    $('formMessage').textContent = 'اكتملت العملية الحالية. اضغط «عملية جديدة» لبدء تذكرة أخرى.';
  }
  function updateCaptureUI() {
    $('firstWeight').textContent = firstCapture ? fmt(firstCapture.weight) + ' كجم' : '—';
    $('firstTime').textContent = firstCapture ? stamp(new Date(firstCapture.time)) : 'لم تسجل بعد';
    $('secondWeight').textContent = secondCapture ? fmt(secondCapture.weight) + ' كجم' : '—';
    $('secondTime').textContent = secondCapture ? stamp(new Date(secondCapture.time)) : 'لم تسجل بعد';
    $('netWeight').textContent = firstCapture && secondCapture ? fmt(Math.abs(firstCapture.weight - secondCapture.weight)) + ' كجم' : '—';
    $('weighStep').textContent = secondCapture ? 'اكتملت الوزنتان' : firstCapture ? 'الوزنة الثانية' : 'الوزنة الأولى';
    $('captureWeight').textContent = secondCapture ? 'اكتملت العملية' : firstCapture ? 'تسجيل الوزنة الثانية' : 'تسجيل الوزنة الأولى';
    $('captureWeight').disabled = Boolean(secondCapture);
  }
  function resetTicket() {
    firstCapture = null; secondCapture = null;
    $('formMessage').textContent = '';
    $('plateInput').value = ''; $('driverInput').value = ''; $('customerInput').value = '';
    updateCaptureUI(); $('plateInput').focus();
  }
  function openTicket(record) {
    activeRecord = record;
    $('ticketContent').innerHTML = ticketMarkup(record);
    $('ticketModal').classList.add('open');
  }
  function ticketMarkup(r) {
    return '<div class="ticket-paper"><div class="ticket-brand"><h2>WEIGHBRIDGE 120T</h2><p>تذكرة وزن شاحنة · Truck Weighing Ticket</p></div><div class="ticket-number">رقم التذكرة: ' + esc(r.id) + '</div><div class="ticket-grid">' +
      ticketField('رقم السيارة',r.plate) + ticketField('السائق',r.driver) + ticketField('العميل',r.customer) +
      ticketField('تاريخ العملية',stamp(new Date(r.createdAt))) + ticketField('الوزنة الأولى',fmt(r.firstWeight)+' كجم') + ticketField('الوزنة الثانية',fmt(r.secondWeight)+' كجم') +
      '</div><div class="ticket-net"><small>صافي الحمولة</small><strong>' + fmt(r.netWeight) + ' كجم</strong></div><div class="ticket-footer">مصدر القراءة: محاكي افتراضي · هذه التذكرة تجريبية وليست مستند وزن معتمدًا</div></div>';
  }
  function ticketField(label, value) { return '<div class="ticket-field"><small>'+esc(label)+'</small><strong>'+esc(String(value))+'</strong></div>'; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function rowMarkup(r, detailed = false) {
    const cells = '<td><strong>'+esc(r.id)+'</strong></td><td>'+esc(r.plate)+'</td>' +
      (detailed ? '<td>'+esc(r.driver)+'</td>' : '') +
      '<td>'+esc(r.customer)+'</td><td>'+fmt(r.firstWeight)+'</td><td>'+fmt(r.secondWeight)+'</td><td><strong class="net-cell">'+fmt(r.netWeight)+'</strong></td><td>'+stamp(new Date(r.createdAt))+'</td>' +
      (detailed ? '<td><button class="table-action" data-ticket="'+esc(r.id)+'">التذكرة</button></td>' : '');
    return '<tr>'+cells+'</tr>';
  }
  function renderAll() {
    const today = dateKey(now());
    const todays = records.filter(r => dateKey(new Date(r.createdAt)) === today);
    const todayNet = todays.reduce((sum,r)=>sum+r.netWeight,0);
    $('todayCount').textContent = fmt(todays.length);
    $('todayNet').innerHTML = fmt(todayNet) + ' <em>كجم</em>';
    $('lastWeighing').textContent = records.length ? stamp(new Date(records[0].createdAt)) : '—';
    $('connectionSummary').textContent = serialPort ? 'متصل Serial' : 'محاكاة';
    $('recentTable').innerHTML = records.length ? records.slice(0,5).map(r=>rowMarkup(r)).join('') : '<tr class="empty-row"><td colspan="7">لا توجد عمليات مسجلة حتى الآن</td></tr>';
    renderRecords();
    renderVehicles();
    renderReports();
    $('todayDate').textContent = now().toLocaleDateString('ar-EG',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  }
  function renderRecords() {
    const q = ($('recordSearch')?.value || '').trim().toLowerCase();
    const filtered = records.filter(r => [r.id,r.plate,r.driver,r.customer].some(v=>String(v).toLowerCase().includes(q)));
    $('recordsTable').innerHTML = filtered.length ? filtered.map(r=>rowMarkup(r,true)).join('') : '<tr class="empty-row"><td colspan="9">لا توجد نتائج مطابقة</td></tr>';
    $('recordCount').textContent = fmt(filtered.length) + ' عملية';
  }
  function renderVehicles() {
    const map = new Map();
    records.forEach(r => {
      const item = map.get(r.plate) || {plate:r.plate,driver:r.driver,customer:r.customer,count:0,net:0};
      item.driver=r.driver; item.customer=r.customer; item.count++; item.net+=r.netWeight; map.set(r.plate,item);
    });
    const vehicles = [...map.values()];
    $('vehicleCount').textContent = fmt(vehicles.length);
    $('driverCount').textContent = fmt(new Set(records.map(r=>r.driver).filter(x=>x!=='—')).size);
    $('customerCount').textContent = fmt(new Set(records.map(r=>r.customer).filter(x=>x!=='—')).size);
    $('vehiclesTable').innerHTML = vehicles.length ? vehicles.map(v=>'<tr><td>'+esc(v.plate)+'</td><td>'+esc(v.driver)+'</td><td>'+esc(v.customer)+'</td><td>'+fmt(v.count)+'</td><td>'+fmt(v.net)+' كجم</td></tr>').join('') : '<tr class="empty-row"><td colspan="5">لا توجد بيانات بعد</td></tr>';
  }
  function renderReports() {
    const total = records.reduce((s,r)=>s+r.netWeight,0);
    $('reportCount').textContent = fmt(records.length);
    $('reportNet').textContent = fmt(total)+' كجم';
    $('reportAverage').textContent = fmt(records.length ? Math.round(total/records.length) : 0)+' كجم';
    const days = Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(6-i));return d;});
    const counts = days.map(d=>records.filter(r=>dateKey(new Date(r.createdAt))===dateKey(d)).length);
    const max = Math.max(1,...counts);
    $('weeklyChart').innerHTML = records.length ? days.map((d,i)=>'<div class="chart-column"><div class="chart-bar" style="height:'+Math.max(4,counts[i]/max*125)+'px"><span>'+counts[i]+'</span></div><small>'+d.toLocaleDateString('ar-EG',{weekday:'short'})+'</small></div>').join('') : '<div class="chart-empty">ستظهر الإحصائيات بعد تسجيل عمليات الوزن.</div>';
  }
  function switchView(name) {
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+name));
    document.querySelectorAll('.nav-link').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
    const titles={dashboard:'لوحة التشغيل',weighings:'سجل عمليات الوزن',vehicles:'السيارات والعملاء',reports:'التقارير والإحصائيات',connections:'الاتصال بأجهزة الوزن',settings:'إعدادات النظام'};
    $('pageTitle').textContent=titles[name]||'لوحة التشغيل';
    $('sidebar').classList.remove('open');
    if(name==='weighings')renderRecords();
  }
  function parseSerialWeight(line) {
    const text = String(line || '').replace(/\u0000/g, '').trim();
    if (!text) return null;
    const match = text.match(/[-+]?\d+(?:[.,]\d+)?/);
    if (!match) return null;
    let value = Number(match[0].replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return null;
    const unit = (text.match(/\b(kg|kgs|g|gram|lb|lbs|ton)\b/i) || [])[0]?.toLowerCase();
    if (unit === 'g' || unit === 'gram') value /= 1000;
    else if (unit === 'lb' || unit === 'lbs') value *= 0.45359237;
    else if (unit === 'ton') value *= 1000;
    return value;
  }
  async function connectSerial() {
    if (!('serial' in navigator)) {
      showToast('الاتصال التسلسلي يحتاج Chrome أو Edge على كمبيوتر عبر HTTPS.');
      $('serialState').textContent = 'المتصفح لا يدعم Web Serial';
      return;
    }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: Number($('serialBaud').value), dataBits: 8, stopBits: 1, parity: 'none' });
      serialReading = true;
      $('serialState').textContent = 'متصل — في انتظار بيانات الميزان';
      $('serialConnect').disabled = true;
      $('serialDisconnect').disabled = false;
      $('connectionSummary').textContent = 'متصل Serial';
      showToast('تم الاتصال بالمنفذ. في انتظار بيانات الميزان.');
      readSerial();
    } catch (error) {
      serialPort = null;
      $('serialState').textContent = 'تعذر الاتصال: ' + (error.message || 'لم يتم اختيار منفذ');
      showToast('لم يتم الاتصال بالميزان');
    }
  }
  async function readSerial() {
    let buffer = '';
    while (serialPort && serialPort.readable && serialReading) {
      try {
        serialReader = serialPort.readable.getReader();
        while (serialReading) {
          const result = await serialReader.read();
          if (result.done) break;
          buffer += new TextDecoder().decode(result.value);
          if ($('serialMode').value === 'continuous') {
            const value = parseSerialWeight(buffer);
            if (value !== null) { setWeight(Math.min(CAPACITY, value)); setStability(true); buffer = ''; }
          } else {
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
              const value = parseSerialWeight(line);
              if (value !== null) {
                setWeight(Math.min(CAPACITY, value));
                setStability(true);
                $('serialState').textContent = 'متصل — آخر قراءة: ' + fmt(value) + ' كجم';
              }
            }
            if (buffer.length > 512) buffer = buffer.slice(-128);
          }
        }
      } catch (error) {
        if (serialReading) $('serialState').textContent = 'انقطع تدفق البيانات: ' + error.message;
      } finally {
        try { serialReader.releaseLock(); } catch {}
        serialReader = null;
      }
    }
  }
  async function disconnectSerial() {
    serialReading = false;
    try { if (serialReader) await serialReader.cancel(); } catch {}
    try { if (serialPort) await serialPort.close(); } catch {}
    serialPort = null;
    serialReader = null;
    $('serialConnect').disabled = false;
    $('serialDisconnect').disabled = true;
    $('serialState').textContent = 'غير متصل — وضع المحاكاة نشط';
    $('connectionSummary').textContent = 'محاكاة';
    showToast('تم قطع الاتصال بالميزان');
  }
  function exportExcel() {
    if (!records.length) { showToast('لا توجد عمليات لتصديرها'); return; }
    if (!window.XLSX) { showToast('مكتبة Excel لم تُحمّل. تحقق من اتصال الإنترنت.'); return; }
    const rows = records.slice().reverse().map(r => ({
      'رقم التذكرة': r.id, 'رقم السيارة': r.plate, 'السائق': r.driver, 'العميل': r.customer,
      'الوزنة الأولى (كجم)': r.firstWeight, 'الوزنة الثانية (كجم)': r.secondWeight,
      'صافي الحمولة (كجم)': r.netWeight, 'مصدر القراءة': r.source,
      'تاريخ العملية': stamp(new Date(r.createdAt))
    }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = [{wch:22},{wch:18},{wch:20},{wch:24},{wch:20},{wch:20},{wch:22},{wch:22},{wch:24}];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'سجل الوزن');
    XLSX.writeFile(book, 'Weighbridge-120T-Records-' + dateKey(now()) + '.xlsx');
    showToast('تم تنزيل ملف Excel بنجاح');
  }

  function exportCSV() {
    if(!records.length){showToast('لا توجد عمليات لتصديرها');return;}
    const header=['رقم التذكرة','السيارة','السائق','العميل','الوزنة الأولى كجم','الوزنة الثانية كجم','الصافي كجم','التاريخ'];
    const lines=[header,...records.map(r=>[r.id,r.plate,r.driver,r.customer,r.firstWeight,r.secondWeight,r.netWeight,stamp(new Date(r.createdAt))])];
    const csv='\uFEFF'+lines.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='weighbridge-records.csv';a.click();URL.revokeObjectURL(url);
    showToast('تم تجهيز ملف CSV');
  }

  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.go)));
  $('mobileMenu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('weightSlider').addEventListener('input',e=>setWeight(e.target.value));
  $('zeroWeight').addEventListener('click',()=>{setWeight(0);showToast('تم تصفير قراءة المحاكي');});
  $('presetLoaded').addEventListener('click',()=>{setWeight(25660);setStability(true);});
  $('presetEmpty').addEventListener('click',()=>{setWeight(10200);setStability(true);});
  $('toggleStability').addEventListener('click',()=>setStability(!isStable));
  $('captureWeight').addEventListener('click',capture);
  $('resetTicket').addEventListener('click',resetTicket);
  $('recordSearch').addEventListener('input',renderRecords);
  $('exportRecords').addEventListener('click',exportCSV);
  $('exportExcel').addEventListener('click',exportExcel);
  $('serialConnect').addEventListener('click',connectSerial);
  $('serialDisconnect').addEventListener('click',disconnectSerial);
  if (!('serial' in navigator)) $('serialState').textContent = 'استخدم Chrome أو Edge على كمبيوتر لعرض منافذ Serial.';
  if (navigator.serial) navigator.serial.addEventListener('disconnect', () => { if (serialPort) disconnectSerial(); });
  $('exportQuick').addEventListener('click',exportCSV);
  $('printReport').addEventListener('click',()=>window.print());
  $('closeTicket').addEventListener('click',()=>$('ticketModal').classList.remove('open'));
  $('closeTicket2').addEventListener('click',()=>$('ticketModal').classList.remove('open'));
  $('printTicket').addEventListener('click',()=>window.print());
  $('ticketModal').addEventListener('click',e=>{if(e.target===$('ticketModal'))$('ticketModal').classList.remove('open');});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-ticket]');if(b){const r=records.find(x=>x.id===b.dataset.ticket);if(r)openTicket(r);}});
  $('saveSettings').addEventListener('click',()=>{settings.systemName=$('systemName').value.trim()||'Weighbridge 120T';localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));document.title=settings.systemName+' | نظام إدارة البسكول';$('settingsMessage').textContent='تم حفظ الإعدادات.';showToast('تم حفظ الإعدادات');});
  $('clearData').addEventListener('click',()=>{if(!confirm('هل أنت متأكد من مسح كل عمليات الوزن المحفوظة في هذا المتصفح؟ لا يمكن التراجع عن هذه الخطوة.'))return;records=[];saveRecords();resetTicket();showToast('تم مسح بيانات التجربة');});
  $('systemName').value=settings.systemName||'Weighbridge 120T';
  setWeight(liveWeight);setStability(true);updateCaptureUI();renderAll();
})();