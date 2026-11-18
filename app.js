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
  let desktopSerialBuffer = '';
  let autoProbeBuffer = '';
  let autoProbeValue = null;
  let autoProbeRunning = false;

  const desktop = window.desktopBridge && window.desktopBridge.isDesktop;
  function readJSON(key, fallback) {
    try {
      const stored = desktop ? window.desktopBridge.getItem(key) : localStorage.getItem(key);
      const value = JSON.parse(stored);
      return value ?? fallback;
    } catch { return fallback; }
  }
  function writeJSON(key, value) {
    const serialized = JSON.stringify(value);
    if (desktop) window.desktopBridge.setItem(key, serialized);
    else localStorage.setItem(key, serialized);
  }
  function saveRecords() { writeJSON(STORAGE_KEY, records); renderAll(); }
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
      '</div><div class="ticket-net"><small>صافي الحمولة</small><strong>' + fmt(r.netWeight) + ' كجم</strong></div><div class="ticket-footer">مصدر القراءة: ' + esc(r.source || 'غير محدد') + ' · راجع معايرة الميزان قبل الاستخدام التجاري أو القانوني</div></div>';
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
    const raw = match[0];
    let normalized = raw;
    if (raw.includes(',') && !raw.includes('.')) {
      const digits = raw.split(',')[1] || '';
      normalized = digits.length === 3 ? raw.replace(/,/g, '') : raw.replace(',', '.');
    } else if (raw.includes(',') && raw.includes('.')) {
      normalized = raw.replace(/,/g, '');
    }
    let value = Number(normalized);
    if (!Number.isFinite(value) || value < 0) return null;
    const detectedUnit = (text.match(/\b(kg|kgs|g|gram|lb|lbs|ton)\b/i) || [])[0]?.toLowerCase();
    const selectedUnit = $('serialUnit')?.value || 'auto';
    const unit = selectedUnit === 'auto' ? detectedUnit : selectedUnit;
    if (unit === 'g' || unit === 'gram') value /= 1000;
    else if (unit === 'lb' || unit === 'lbs') value *= 0.45359237;
    else if (unit === 'ton') value *= 1000;
    return value;
  }
  function parseYaohuaA9Frame(frame) {
    const bytes = Array.from(String(frame || ''), ch => ch.charCodeAt(0) & 0xff);
    // XK3190-A9+ continuous mode: STX, sign, six ASCII digits, decimal position,
    // two ASCII XOR hex digits, ETX. Never treat checksum bytes as weight.
    if (bytes.length !== 12 || bytes[0] !== 0x02 || bytes[11] !== 0x03) return null;
    const sign = String.fromCharCode(bytes[1]);
    if (sign !== '+' && sign !== '-') return null;
    const digits = bytes.slice(2, 8).map(code => String.fromCharCode(code)).join('');
    if (!/^\d{6}$/.test(digits)) return null;
    const decimalChar = String.fromCharCode(bytes[8]);
    if (!/^[0-4]$/.test(decimalChar)) return null;
    let checksum = 0;
    for (let i = 1; i <= 8; i++) checksum ^= bytes[i];
    const hexDigit = value => String.fromCharCode(value < 10 ? 48 + value : 55 + value);
    if (String.fromCharCode(bytes[9]) !== hexDigit((checksum >> 4) & 0x0f) ||
        String.fromCharCode(bytes[10]) !== hexDigit(checksum & 0x0f)) return null;
    let value = Number(digits) / (10 ** Number(decimalChar));
    if (sign === '-') value = -value;
    return Number.isFinite(value) ? value : null;
  }
  function extractYaohuaA9Frames(buffer) {
    const frames = [];
    const stx = String.fromCharCode(0x02);
    const etx = String.fromCharCode(0x03);
    let rest = String(buffer || '');
    while (rest.length) {
      const start = rest.indexOf(stx);
      if (start < 0) return { frames, rest: rest.slice(-1) };
      if (start > 0) rest = rest.slice(start);
      const end = rest.indexOf(etx, 1);
      if (end < 0) return { frames, rest: rest.slice(0, 64) };
      frames.push(rest.slice(0, end + 1));
      rest = rest.slice(end + 1);
    }
    return { frames, rest: '' };
  }
  function applySerialValue(value) {
    if (value === null || !Number.isFinite(value)) return false;
    if (value < 0) {
      $('serialState').textContent = 'قراءة سالبة من المؤشر؛ لم يتم اعتمادها كوزن حمولة.';
      return false;
    }
    setWeight(Math.min(CAPACITY, value));
    setStability(true);
    $('serialState').textContent = 'متصل — آخر قراءة: ' + fmt(value) + ' كجم · ' + ($('protocolProfile').selectedOptions[0]?.text || 'Generic');
    return true;
  }
  function consumeDesktopSerialData(data) {
    if ($('protocolProfile').value === 'yaohua-a9') {
      desktopSerialBuffer += data;
      const extracted = extractYaohuaA9Frames(desktopSerialBuffer);
      desktopSerialBuffer = extracted.rest;
      for (const frame of extracted.frames) {
        const value = parseYaohuaA9Frame(frame);
        if (value !== null) {
          if (autoProbeRunning) autoProbeValue = value;
          applySerialValue(value);
        }
      }
      return;
    }
    if (autoProbeRunning) {
      const probeValue = parseSerialWeight(data);
      if (probeValue !== null) autoProbeValue = probeValue;
    }
    desktopSerialBuffer += data;
    const split = splitSerialFrames(desktopSerialBuffer, $('serialMode').value);
    desktopSerialBuffer = split.rest;
    for (const frame of split.frames) applySerialValue(parseSerialWeight(frame));
    if (desktopSerialBuffer.length > 2048) desktopSerialBuffer = desktopSerialBuffer.slice(-256);
  }
  async function connectSerial() {
    if (desktop) {
      try {
        const selectedPath = $('serialDevice').value;
        if (!selectedPath) { showToast('اختر منفذ COM أولاً'); return; }
        await window.desktopBridge.openSerialPort({
          path: selectedPath,
          baudRate: Number($('serialBaud').value),
          dataBits: Number($('serialDataBits').value),
          stopBits: Number($('serialStopBits').value),
          parity: $('serialParity').value,
          flowControl: $('serialFlow').value
        });
        serialPort = { desktop: true };
        serialReading = true;
        desktopSerialBuffer = '';
        $('serialState').textContent = 'متصل بالمنفذ ' + selectedPath + ' — في انتظار بيانات الميزان';
        $('serialConnect').disabled = true;
        $('serialDisconnect').disabled = false;
        $('connectionSummary').textContent = 'متصل Serial';
        showToast('تم فتح منفذ الميزان');
      } catch (error) {
        serialPort = null;
        $('serialState').textContent = 'تعذر الاتصال: ' + error.message;
        showToast('لم يتم الاتصال بالميزان');
      }
      return;
    }
    if (!('serial' in navigator)) {
      showToast('الاتصال التسلسلي يحتاج Chrome أو Edge على كمبيوتر عبر HTTPS.');
      $('serialState').textContent = 'المتصفح لا يدعم Web Serial';
      return;
    }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: Number($('serialBaud').value), dataBits: Number($('serialDataBits').value), stopBits: Number($('serialStopBits').value), parity: $('serialParity').value, flowControl: $('serialFlow').value });
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
  function splitSerialFrames(buffer, mode) {
    if (mode === 'stx') {
      const frames = [];
      let rest = buffer;
      const stx = String.fromCharCode(2);
      const etx = String.fromCharCode(3);
      while (true) {
        const begin = rest.indexOf(stx);
        if (begin < 0) return { frames, rest: rest.slice(-2048) };
        const finish = rest.indexOf(etx, begin + 1);
        if (finish < 0) return { frames, rest: rest.slice(begin) };
        frames.push(rest.slice(begin + 1, finish));
        rest = rest.slice(finish + 1);
      }
    }
    if (mode === 'continuous') {
      const chunks = buffer.split(/[\r\n]+/).filter(Boolean);
      if (chunks.length > 1) return { frames: chunks.slice(0, -1), rest: chunks[chunks.length - 1].slice(-256) };
      if (buffer.length >= 24) return { frames: [buffer], rest: buffer.slice(-12) };
      return { frames: [], rest: buffer };
    }
    const lines = buffer.split(/[\r\n]+/);
    return { frames: lines.slice(0, -1).filter(Boolean), rest: lines[lines.length - 1] || '' };
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
          if ($('protocolProfile').value === 'yaohua-a9') {
            const extracted = extractYaohuaA9Frames(buffer);
            buffer = extracted.rest;
            for (const frame of extracted.frames) applySerialValue(parseYaohuaA9Frame(frame));
          } else {
            const split = splitSerialFrames(buffer, $('serialMode').value);
            buffer = split.rest;
            for (const frame of split.frames) applySerialValue(parseSerialWeight(frame));
          }
          if (buffer.length > 2048) buffer = buffer.slice(-256);
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
    if (desktop && serialPort?.desktop) {
      try { await window.desktopBridge.closeSerialPort(); } catch {}
      serialPort = null;
      $('serialConnect').disabled = false;
      $('serialDisconnect').disabled = true;
      $('serialState').textContent = 'غير متصل — وضع المحاكاة نشط';
      $('connectionSummary').textContent = 'محاكاة';
      showToast('تم قطع الاتصال بالميزان');
      return;
    }
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

    $('protocolProfile').addEventListener('change', () => {
      const profile = $('protocolProfile').value;
      if (profile === 'yaohua-a9') {
        $('serialMode').value = 'yaohua-a9';
        $('serialBaud').value = '9600';
        $('serialDataBits').value = '8';
        $('serialParity').value = 'none';
        $('serialStopBits').value = '1';
        $('serialFlow').value = 'none';
        $('serialUnit').value = 'kg';
        $('serialState').textContent = 'ملف YAOHUA جاهز. تأكد أن المؤشر مضبوط على tF=0 (إرسال مستمر) ونفس سرعة Baud.';
      } else if (profile === 'stx-etx') $('serialMode').value = 'stx';
      else if (profile === 'raw-stream') $('serialMode').value = 'continuous';
      else if (['rice-continuous','rice-demand','mettler','avery','cas','generic'].includes(profile)) $('serialMode').value = 'lines';
    });
  if (desktop) {
    const refreshPorts = async () => {
      try {
        const ports = await window.desktopBridge.listSerialPorts();
        const select = $('serialDevice');
        const previous = select.value;
        select.innerHTML = '<option value="">اختر منفذ الميزان</option>';
        ports.forEach(port => {
          const option = document.createElement('option');
          option.value = port.path;
          option.textContent = port.path + (port.manufacturer ? ' — ' + port.manufacturer : '');
          select.appendChild(option);
        });
        if (ports.some(port => port.path === previous)) select.value = previous;
        if (!ports.length) $('serialState').textContent = 'لم يتم العثور على منافذ COM. افحص الكابل والتعريف.';
      } catch (error) { $('serialState').textContent = 'تعذر قراءة منافذ COM: ' + error.message; }
    };
    $('refreshSerialPorts').addEventListener('click', refreshPorts);
    $('autoSerialSettings').addEventListener('click', async () => {
      if (autoProbeRunning) return;
      const path = $('serialDevice').value;
      if (!path) { showToast('اختر منفذ الميزان أولاً'); return; }
      autoProbeRunning = true;
      $('autoSerialSettings').disabled = true;
      $('serialState').textContent = 'يجرب إعدادات الاتصال الشائعة… اترك المؤشر يرسل بيانات الوزن.';
      const candidates = [];
      for (const baudRate of [9600, 4800, 19200, 2400, 1200, 38400, 57600, 115200, 300, 600, 230400]) {
        for (const parity of ['none', 'even', 'odd']) candidates.push({ baudRate, dataBits: 8, stopBits: 1, parity, flowControl: 'none' });
      }
      try {
        for (let i = 0; i < candidates.length; i++) {
          const config = candidates[i];
          $('serialState').textContent = 'اختبار ' + config.baudRate + ' baud / ' + config.parity + ' (' + (i + 1) + '/' + candidates.length + ')';
          try {
            await window.desktopBridge.closeSerialPort();
            autoProbeValue = null;
            autoProbeBuffer = '';
            desktopSerialBuffer = '';
            await window.desktopBridge.openSerialPort({ path, ...config });
            serialPort = { desktop: true };
            serialReading = true;
            desktopSerialBuffer = '';
            await new Promise(resolve => setTimeout(resolve, 1300));
            if (autoProbeValue !== null) {
              $('serialBaud').value = String(config.baudRate);
              $('serialDataBits').value = String(config.dataBits);
              $('serialStopBits').value = String(config.stopBits);
              $('serialParity').value = config.parity;
              $('serialFlow').value = 'none';
              $('serialConnect').disabled = true;
              $('serialDisconnect').disabled = false;
              $('serialState').textContent = 'تم العثور على قراءة بالاعدادات: ' + config.baudRate + ' / 8-' + config.parity + '-1';
              showToast('تم العثور على إعداد اتصال يستقبل الوزن');
              return;
            }
          } catch {}
        }
        await window.desktopBridge.closeSerialPort();
        serialPort = null;
        $('serialState').textContent = 'لم يتم اكتشاف قراءة. جرّب إعدادًا يدويًا أو تحقق من إرسال المؤشر للبيانات.';
        showToast('لم تنجح التجربة التلقائية');
      } finally {
        autoProbeRunning = false;
        $('autoSerialSettings').disabled = false;
      }
    });
    $('usbHelp').addEventListener('click', () => { refreshPorts(); showToast('محولات USB-to-Serial تظهر هنا كمنفذ COM.'); });

    refreshPorts();
    window.desktopBridge.onSerialData(data => consumeDesktopSerialData(data));
    window.desktopBridge.onSerialError(error => { $('serialState').textContent = 'خطأ في منفذ COM: ' + error; });
    window.desktopBridge.onSerialClosed(() => {
      serialPort = null; serialReading = false;
      $('serialConnect').disabled = false; $('serialDisconnect').disabled = true;
      $('serialState').textContent = 'تم إغلاق منفذ COM';
    });
  } else {
    $('serialDevice').disabled = true;
    $('refreshSerialPorts').disabled = true;
    $('serialDevice').innerHTML = '<option>اختر المنفذ من نافذة اتصال المتصفح</option>';
  }

  if (desktop) {
    $('storageMode').textContent = 'SQLite';
    $('storageDescription').textContent = 'قاعدة بيانات محلية على هذا الكمبيوتر — لا تحتاج إنترنت';
    $('tcpConnect').addEventListener('click', async () => {
      try {
        await window.desktopBridge.tcpConnect({ host: $('tcpHost').value, port: $('tcpPort').value });
        $('tcpState').textContent = 'متصل — يستقبل البيانات من الشبكة المحلية';
        $('tcpConnect').disabled = true; $('tcpDisconnect').disabled = false;
        showToast('تم اتصال TCP');
      } catch (error) { $('tcpState').textContent = 'فشل الاتصال: ' + error.message; }
    });
    $('tcpDisconnect').addEventListener('click', async () => {
      await window.desktopBridge.tcpDisconnect();
      $('tcpState').textContent = 'تم قطع اتصال TCP';
      $('tcpConnect').disabled = false; $('tcpDisconnect').disabled = true;
    });
    window.desktopBridge.onTcpData(data => {
      const value = parseSerialWeight(data);
      if (value !== null) {
        setWeight(Math.min(CAPACITY, value)); setStability(true);
        $('tcpState').textContent = 'متصل — آخر قراءة: ' + fmt(value) + ' كجم';
      }
    });
    window.desktopBridge.onTcpClosed(() => {
      $('tcpState').textContent = 'انقطع اتصال TCP';
      $('tcpConnect').disabled = false; $('tcpDisconnect').disabled = true;
    });
  } else {
    $('tcpConnect').disabled = true;
    $('tcpDisconnect').disabled = true;
    $('tcpState').textContent = 'اتصال TCP الخام متاح في نسخة Windows فقط';
  }

  if (!desktop && !('serial' in navigator)) $('serialState').textContent = 'استخدم Chrome أو Edge على كمبيوتر لعرض منافذ Serial.';
  if (navigator.serial) navigator.serial.addEventListener('disconnect', () => { if (serialPort) disconnectSerial(); });
  $('exportQuick').addEventListener('click',exportCSV);
  $('printReport').addEventListener('click',()=>window.print());
  $('closeTicket').addEventListener('click',()=>$('ticketModal').classList.remove('open'));
  $('closeTicket2').addEventListener('click',()=>$('ticketModal').classList.remove('open'));
  $('printTicket').addEventListener('click',()=>window.print());
  $('ticketModal').addEventListener('click',e=>{if(e.target===$('ticketModal'))$('ticketModal').classList.remove('open');});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-ticket]');if(b){const r=records.find(x=>x.id===b.dataset.ticket);if(r)openTicket(r);}});
  $('saveSettings').addEventListener('click',()=>{settings.systemName=$('systemName').value.trim()||'Weighbridge 120T';writeJSON(SETTINGS_KEY,settings);document.title=settings.systemName+' | نظام إدارة البسكول';$('settingsMessage').textContent='تم حفظ الإعدادات.';showToast('تم حفظ الإعدادات');});
  $('clearData').addEventListener('click',()=>{if(!confirm('هل أنت متأكد من مسح كل عمليات الوزن المحفوظة في هذا المتصفح؟ لا يمكن التراجع عن هذه الخطوة.'))return;records=[];saveRecords();resetTicket();showToast('تم مسح بيانات التجربة');});
  $('systemName').value=settings.systemName||'Weighbridge 120T';
  setWeight(liveWeight);setStability(true);updateCaptureUI();renderAll();
})();