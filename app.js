(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'weighbridge120t.records.v1';
  const SETTINGS_KEY = 'weighbridge120t.settings.v1';
  const CAPACITY = 500000;
  let records = readJSON(STORAGE_KEY, []);
  let settings = readJSON(SETTINGS_KEY, { systemName: 'Weighbridge 120T' });
  let liveWeight = 0;
  let rawScaleWeight = null;
  let isStable = true;
  let activeWeightSource = "waiting";
  let firstCapture = null;
  let secondCapture = null;
  let activeTicketDetails = null;
  let activeRecord = null;
  let toastTimer = null;
  let serialPort = null;
  let serialReader = null;
  let serialReading = false;
  let desktopSerialBuffer = '';
  let autoScanBuffer = '';
  let autoScanReadings = [];
  let autoScanDetected = null;
  let autoScanAttemptActive = false;
  let autoScanRunning = false;
  let autoDetectionEnabled = true;
  let autoRetryAt = 0;
  let lastPortsSignature = null;

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
    if (document.activeElement !== $('manualWeight')) $('manualWeight').value = liveWeight;
    $('weightSourceLabel').textContent = activeWeightSource === 'serial' ? 'قراءة من الميزان' : activeWeightSource === 'manual' ? 'إدخال يدوي' : 'بانتظار القراءة';
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

  }
  function capture() {
    if (activeWeightSource === 'waiting') { $('formMessage').textContent = 'اختر الإدخال اليدوي أو وصّل الميزان وانتظر أول قراءة.'; return; }
    if (!isStable) { $('formMessage').textContent = 'لا يمكن تسجيل الوزن قبل استقرار القراءة.'; return; }
    if (liveWeight > CAPACITY) { $('formMessage').textContent = 'الوزن يتجاوز السعة القصوى.'; return; }
    if (activeWeightSource === 'manual' && !$('manualWeight').value.trim()) {
      $('formMessage').textContent = firstCapture
        ? 'اكتب قراءة الوزنة الثانية أولًا؛ الوزن يتحدث تلقائيًا.'
        : 'اكتب الوزن أولًا؛ القراءة تتحدث تلقائيًا.';
      $('manualWeight').focus();
      return;
    }
    if (activeWeightSource !== 'manual' && rawScaleWeight == null) {
      $('formMessage').textContent = 'بانتظار قراءة جديدة من الميزان قبل تسجيل الوزن.';
      return;
    }
    const plate = $('plateInput').value.trim();
    if (!plate) { $('formMessage').textContent = 'اكتب رقم السيارة أولًا.'; $('plateInput').focus(); return; }
    const originalWeight = rawScaleWeight == null ? null : Math.round(Number(rawScaleWeight) * 100) / 100;
    const captureData = { weight: liveWeight, originalWeight, adjusted: originalWeight != null && Math.abs(originalWeight - liveWeight) > 0.005, time: now().toISOString(), source: activeWeightSource };
    const ticketDetails = {
      plate,
      trailer: $('trailerInput').value.trim() || '—',
      driver: $('driverInput').value.trim() || '—',
      customer: $('customerInput').value.trim() || '—',
      shipment: $('shipmentInput').value.trim() || '—',
      governorate: $('governorateInput').value || '—',
      movementType: $('movementTypeInput').value || 'وارد'
    };
    rawScaleWeight = null;
    if (!firstCapture) {
      firstCapture = captureData;
      activeTicketDetails = ticketDetails;
      if (activeWeightSource !== 'manual') activeWeightSource = 'waiting';
      setWeight(0);
      $('manualWeight').value = '';
      setStability(false);
      $('formMessage').textContent = 'تم حفظ الوزنة الأولى وبيانات العملية. أدخل الوزن الجديد لتسجيل الوزنة الثانية.';
      updateCaptureUI();
      showToast('تم تسجيل الوزنة الأولى');
      return;
    }
    if (!secondCapture) {
      secondCapture = captureData;
      const net = Math.abs(firstCapture.weight - secondCapture.weight);
      const record = {
        id: ticketNo(), ...(activeTicketDetails || ticketDetails),
        firstWeight: firstCapture.weight, secondWeight: secondCapture.weight,
        firstOriginalWeight: firstCapture.originalWeight, secondOriginalWeight: secondCapture.originalWeight,
        firstAdjusted: firstCapture.adjusted, secondAdjusted: secondCapture.adjusted,
        firstSource: firstCapture.source, secondSource: secondCapture.source,
        netWeight: net, firstTime: firstCapture.time, secondTime: secondCapture.time,
        createdAt: now().toISOString(), source: [firstCapture.source, secondCapture.source].every(s => s === 'serial') ? 'RS232 / USB Serial' : [firstCapture.source, secondCapture.source].every(s => s === 'manual') ? 'إدخال يدوي' : 'مختلط: قراءة ميزان / إدخال يدوي'
      };
      records.unshift(record); activeRecord = record; saveRecords();
      $('formMessage').textContent = 'اكتملت عملية الوزن وحُفظت التذكرة بنجاح.';
      updateCaptureUI(); showToast('تم حفظ التذكرة ' + record.id); openTicket(record);
      return;
    }
    $('formMessage').textContent = 'اكتملت العملية الحالية. اضغط «عملية جديدة» لبدء تذكرة أخرى.';
  }
  function updateCaptureUI() {
    const hasFirst = Boolean(firstCapture);
    const hasSecond = Boolean(secondCapture);
    $('firstWeight').textContent = hasFirst ? fmt(firstCapture.weight) + ' كجم' : '—';
    $('firstTime').textContent = hasFirst ? stamp(new Date(firstCapture.time)) : 'لم تسجل بعد';
    $('secondWeight').textContent = hasSecond ? fmt(secondCapture.weight) + ' كجم' : '—';
    $('secondTime').textContent = hasSecond ? stamp(new Date(secondCapture.time)) : 'لم تسجل بعد';
    $('netWeight').textContent = hasFirst && hasSecond ? fmt(Math.abs(firstCapture.weight - secondCapture.weight)) + ' كجم' : '—';
    $('ticketDetailsFields').hidden = hasFirst;
    $('ticketDetailsSummary').hidden = !hasFirst;
    $('secondCaptureBox').hidden = !hasFirst;
    $('captureArrow').hidden = !hasFirst;
    $('netCaptureBox').hidden = !hasSecond;
    if (hasFirst && activeTicketDetails) {
      const details = [
        ['العميل', activeTicketDetails.customer], ['السائق', activeTicketDetails.driver],
        ['الشحنة', activeTicketDetails.shipment], ['المحافظة', activeTicketDetails.governorate],
        ['الحركة', activeTicketDetails.movementType], ['السيارة', activeTicketDetails.plate],
        ['المقطورة', activeTicketDetails.trailer]
      ];
      $('ticketDetailsSummary').innerHTML = details.map(([label,value]) =>
        '<div class="ticket-summary-item"><small>'+esc(label)+'</small><strong>'+esc(value || '—')+'</strong></div>'
      ).join('');
    }
    $('captureHelp').textContent = hasSecond
      ? 'اكتملت الوزنتان وتم حفظ بيانات العملية.'
      : hasFirst
        ? 'تم تثبيت بيانات الشحنة والوزنة الأولى؛ سجّل الوزنة الثانية فقط.'
        : 'أدخل بيانات العملية ثم سجّل الوزنة الأولى';
    $('weighStep').textContent = hasSecond ? 'اكتملت الوزنتان' : hasFirst ? 'الوزنة الثانية' : 'الوزنة الأولى';
    $('captureWeight').textContent = hasSecond ? 'اكتملت العملية' : hasFirst ? 'تسجيل الوزنة الثانية' : 'تسجيل الوزنة الأولى';
    $('captureWeight').disabled = hasSecond;
  }
  function resetTicket() {
    firstCapture = null; secondCapture = null; activeTicketDetails = null;
    $('manualWeight').value = '';
    $('formMessage').textContent = '';
    $('plateInput').value = '';
    $('trailerInput').value = '';
    $('driverInput').value = '';
    $('customerInput').value = '';
    $('shipmentInput').value = '';
    $('governorateInput').value = '';
    $('movementTypeInput').value = 'وارد';
    updateCaptureUI(); $('plateInput').focus();
  }
  function openTicket(record) {
    activeRecord = record;
    $('ticketContent').innerHTML = ticketMarkup(record);
    $('ticketModal').classList.add('open');
  }
  function ticketMarkup(r) {
    return '<div class="ticket-paper"><div class="ticket-brand"><h2>WEIGHBRIDGE 120T</h2><p>تذكرة وزن شاحنة · Truck Weighing Ticket</p></div><div class="ticket-number">رقم التذكرة: ' + esc(r.id) + '</div><div class="ticket-grid">' +
      ticketField('نوع الحركة',r.movementType || '—') + ticketField('اسم العميل',r.customer) +
      ticketField('اسم السائق',r.driver) + ticketField('اسم الشحنة',r.shipment || '—') +
      ticketField('المحافظة',r.governorate || '—') + ticketField('رقم السيارة',r.plate) +
      ticketField('رقم المقطورة',r.trailer || '—') + ticketField('تاريخ العملية',stamp(new Date(r.createdAt))) +
      ticketField('الوزنة الأولى',fmt(r.firstWeight)+' كجم') + ticketField('الوزنة الثانية',fmt(r.secondWeight)+' كجم') +
      '</div><div class="ticket-net"><small>صافي الحمولة</small><strong>' + fmt(r.netWeight) + ' كجم</strong></div><div class="ticket-footer">مصدر القراءة: ' + esc(r.source || 'غير محدد') + ' · راجع معايرة الميزان قبل الاستخدام التجاري أو القانوني</div></div>';
  }
  function ticketField(label, value) { return '<div class="ticket-field"><small>'+esc(label)+'</small><strong>'+esc(String(value))+'</strong></div>'; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function rowMarkup(r, detailed = false) {
    const movement = esc(r.movementType || '—');
    const cells = detailed
      ? '<td><strong>'+esc(r.id)+'</strong></td><td>'+movement+'</td><td>'+esc(r.plate)+'</td><td>'+esc(r.trailer || '—')+'</td>' +
        '<td>'+esc(r.driver)+'</td><td>'+esc(r.customer)+'</td><td>'+esc(r.shipment || '—')+'</td><td>'+esc(r.governorate || '—')+'</td>' +
        '<td>'+fmt(r.firstWeight)+'</td><td>'+fmt(r.secondWeight)+'</td><td><strong class="net-cell">'+fmt(r.netWeight)+'</strong></td><td>'+stamp(new Date(r.createdAt))+'</td>' +
        '<td><div class="table-actions"><button class="table-action" data-ticket="'+esc(r.id)+'">التذكرة</button><button class="table-action" data-export-ticket="'+esc(r.id)+'">تصدير Excel</button><button class="table-action delete-row-action" data-delete-record="'+esc(r.id)+'">حذف</button></div></td>'
      : '<td><strong>'+esc(r.id)+'</strong></td><td>'+movement+'</td><td>'+esc(r.plate)+'</td><td>'+esc(r.trailer || '—')+'</td>' +
        '<td>'+esc(r.customer)+'</td><td>'+esc(r.driver)+'</td><td>'+esc(r.shipment || '—')+'</td><td><strong class="net-cell">'+fmt(r.netWeight)+'</strong></td><td>'+stamp(new Date(r.createdAt))+'</td>' +
        '<td><button class="table-action" data-export-ticket="'+esc(r.id)+'">تصدير ملف Excel</button></td>';
    return '<tr>'+cells+'</tr>';
  }
  function searchRecords(query) {
    const q = String(query || '').trim().toLocaleLowerCase('ar');
    if (!q) return records.slice();
    return records.filter(r => {
      const values = [
        r.id, r.movementType, r.plate, r.trailer, r.driver, r.customer, r.shipment, r.governorate, r.source, r.firstSource, r.secondSource,
        r.firstWeight, r.secondWeight, r.netWeight, r.firstOriginalWeight, r.secondOriginalWeight,
        r.createdAt, r.firstTime, r.secondTime,
        r.createdAt ? stamp(new Date(r.createdAt)) : '',
        r.firstTime ? stamp(new Date(r.firstTime)) : '',
        r.secondTime ? stamp(new Date(r.secondTime)) : ''
      ];
      return values.some(value => String(value ?? '').toLocaleLowerCase('ar').includes(q));
    });
  }
  function deleteRecord(id) {
    const record = records.find(r => r.id === id);
    if (!record) return;
    if (!confirm('هل تريد حذف التذكرة ' + record.id + ' للسيارة ' + record.plate + '؟')) return;
    records = records.filter(r => r.id !== id);
    if (activeRecord?.id === id) {
      activeRecord = null;
      $('ticketModal').classList.remove('open');
    }
    saveRecords();
    showToast('تم حذف التذكرة ' + id + ' وتحديث ملف Excel');
  }
  function deleteAllRecords() {
    if (!records.length) { showToast('لا توجد سجلات لحذفها'); return; }
    const count = records.length;
    if (!confirm('تحذير: سيتم حذف جميع سجلات الوزن (' + count + ' عملية) نهائيًا من البرنامج وملف Excel. هل تريد المتابعة؟')) return;
    records = [];
    activeRecord = null;
    $('ticketModal').classList.remove('open');
    saveRecords();
    resetTicket();
    showToast('تم حذف جميع السجلات وتحديث ملف Excel');
  }
  function updateConnectionCard() {
    const isConnected = Boolean(serialPort && !serialPort.autoPending);
    const status = $('connectionSummary');
    const dot = $('connectionStatusDot');
    if (status) status.textContent = isConnected ? 'متصل' : 'غير متصل';
    if (dot) dot.className = 'connection-dot ' + (isConnected ? 'is-connected' : 'is-disconnected');
  }
  function renderAll() {
    const today = dateKey(now());
    const todays = records.filter(r => dateKey(new Date(r.createdAt)) === today);
    const todayNet = todays.reduce((sum,r)=>sum+r.netWeight,0);
    $('todayCount').textContent = fmt(todays.length);
    $('todayNet').innerHTML = fmt(todayNet) + ' <em>كجم</em>';
    $('lastWeighing').textContent = records.length ? stamp(new Date(records[0].createdAt)) : '—';
    updateConnectionCard();
    $('sidebarDeviceStatus').textContent = serialPort ? (serialPort.auto ? 'تم التعرف على الميزان تلقائيًا' : 'الميزان متصل') : 'بانتظار توصيل الميزان';
    $('recentTable').innerHTML = records.length ? records.slice(0,5).map(r=>rowMarkup(r)).join('') : '<tr class="empty-row"><td colspan="10">لا توجد عمليات مسجلة حتى الآن</td></tr>';
    renderRecords();
    renderVehicles();
    renderReports();
    $('todayDate').textContent = now().toLocaleDateString('ar-EG',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  }
  function renderRecords() {
    const filtered = searchRecords($('recordSearch')?.value || '');
    $('recordsTable').innerHTML = filtered.length ? filtered.map(r=>rowMarkup(r,true)).join('') : '<tr class="empty-row"><td colspan="9">'+(records.length ? 'لا توجد سجلات مطابقة للبحث' : 'لا توجد عمليات مسجلة')+'</td></tr>';
    $('recordCount').textContent = fmt(filtered.length) + ' من أصل ' + fmt(records.length) + ' عملية';
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
    const filtered = searchRecords($('reportSearch')?.value || '');
    const total = filtered.reduce((s,r)=>s+r.netWeight,0);
    $('reportCount').textContent = fmt(filtered.length);
    $('reportNet').textContent = fmt(total)+' كجم';
    $('reportAverage').textContent = fmt(filtered.length ? Math.round(total/filtered.length) : 0)+' كجم';
    $('reportResultCount').textContent = fmt(filtered.length) + ' نتيجة من أصل ' + fmt(records.length) + ' عملية';
    const days = Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(6-i));return d;});
    const counts = days.map(d=>filtered.filter(r=>dateKey(new Date(r.createdAt))===dateKey(d)).length);
    const max = Math.max(1,...counts);
    $('weeklyChart').innerHTML = filtered.length ? days.map((d,i)=>'<div class="chart-column"><div class="chart-bar" style="height:'+Math.max(4,counts[i]/max*125)+'px"><span>'+counts[i]+'</span></div><small>'+d.toLocaleDateString('ar-EG',{weekday:'short'})+'</small></div>').join('') : '<div class="chart-empty">'+(records.length ? 'لا توجد سجلات مطابقة للبحث.' : 'ستظهر الإحصائيات بعد تسجيل عمليات الوزن.')+'</div>';
    $('reportRecordsTable').innerHTML = filtered.length ? filtered.map(r=>rowMarkup(r,true)).join('') : '<tr class="empty-row"><td colspan="9">'+(records.length ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد عمليات مسجلة')+'</td></tr>';
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
  function addAutoScanReading(value, profile, mode) {
    if (!Number.isFinite(value) || value < 0 || value > CAPACITY) return;
    const previous = autoScanReadings[autoScanReadings.length - 1];
    if (previous && (previous.profile !== profile || previous.mode !== mode)) autoScanReadings = [];
    autoScanReadings.push({ value: Math.round(value * 100) / 100, profile, mode, time: Date.now() });
    if (autoScanReadings.length > 5) autoScanReadings.shift();
    if (autoScanReadings.length < 3) return;
    const sample = autoScanReadings.slice(-3);
    const values = sample.map(item => item.value);
    const spread = Math.max(...values) - Math.min(...values);
    const tolerance = Math.max(0.5, Math.max(...values) * 0.0001);
    if (spread <= tolerance) {
      autoScanDetected = { ...sample[sample.length - 1], readings: values };
    }
  }

  function inspectAutoScanLine(line) {
    const clean = String(line || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim();
    if (!clean) return;
    const value = parseSerialWeight(clean);
    if (value !== null) addAutoScanReading(value, 'generic', 'lines');
  }

  function consumeAutoScanData(data) {
    const incoming = String(data || '');
    const stx = String.fromCharCode(0x02);
    const etx = String.fromCharCode(0x03);
    if (!autoScanBuffer.includes(stx) && !incoming.includes(stx) && !incoming.includes(etx) && !/[\r\n]/.test(incoming)) {
      const chunkValue = parseSerialWeight(incoming);
      if (chunkValue !== null) addAutoScanReading(chunkValue, 'generic', 'continuous');
    }
    autoScanBuffer += incoming;

    while (true) {
      const start = autoScanBuffer.indexOf(stx);
      if (start < 0) break;
      if (start > 0) {
        const prefix = autoScanBuffer.slice(0, start);
        prefix.split(/[\r\n]+/).forEach(inspectAutoScanLine);
        autoScanBuffer = autoScanBuffer.slice(start);
      }
      const end = autoScanBuffer.indexOf(etx, 1);
      if (end < 0) break;
      const frame = autoScanBuffer.slice(0, end + 1);
      const yaohuaValue = parseYaohuaA9Frame(frame);
      if (yaohuaValue !== null) {
        addAutoScanReading(yaohuaValue, 'yaohua-a9', 'yaohua-a9');
      } else {
        const inner = frame.slice(1, -1).replace(/[\x00-\x1F]/g, ' ').trim();
        const value = parseSerialWeight(inner);
        if (value !== null) addAutoScanReading(value, 'stx-etx', 'stx');
      }
      autoScanBuffer = autoScanBuffer.slice(end + 1);
    }

    const chunks = autoScanBuffer.split(/[\r\n]+/);
    autoScanBuffer = chunks.pop() || '';
    chunks.forEach(inspectAutoScanLine);

    if (autoScanBuffer.length > 512) autoScanBuffer = autoScanBuffer.slice(-128);
  }

  function applyDetectedSerialConfig(port, config, detected) {
    $('serialDevice').value = port.path;
    $('serialBaud').value = String(config.baudRate);
    $('serialDataBits').value = String(config.dataBits);
    $('serialStopBits').value = String(config.stopBits);
    $('serialParity').value = config.parity;
    $('serialFlow').value = 'none';
    $('protocolProfile').value = detected.profile;
    $('serialMode').value = detected.mode;
    $('serialUnit').value = 'auto';
    $('weightMode').value = 'auto';
    activeWeightSource = 'serial';
    rawScaleWeight = detected.value;
    setWeight(detected.value);
    setStability(true);
    serialPort = { desktop: true, path: port.path, auto: true };
    serialReading = true;
    $('serialConnect').disabled = true;
    $('serialDisconnect').disabled = false;
    $('sidebarDeviceStatus').textContent = 'تم التعرف على الميزان تلقائيًا';
    $('serialState').textContent = 'تم التعرف على الميزان تلقائيًا: ' + port.path + ' · ' + config.baudRate + ' baud · ' + config.dataBits + '-' + config.parity + '-' + config.stopBits;
    renderAll();
    showToast('تم التعرف على الميزان وتوصيله تلقائيًا');
  }

  async function autoDetectSerialPorts(ports) {
    if (autoScanRunning || !autoDetectionEnabled || $('weightMode').value === 'manual' || serialPort) return;
    autoScanRunning = true;
    const commonBauds = [9600, 4800, 19200, 2400, 1200, 38400, 57600, 115200, 600, 300, 230400];
    const configs = commonBauds.map(baudRate => ({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
    for (const baudRate of [9600, 4800, 2400, 19200]) {
      configs.push(
        { baudRate, dataBits: 7, stopBits: 1, parity: 'even', flowControl: 'none' },
        { baudRate, dataBits: 7, stopBits: 1, parity: 'odd', flowControl: 'none' },
        { baudRate, dataBits: 8, stopBits: 1, parity: 'even', flowControl: 'none' }
      );
    }
    const usbSerialVendors = new Set(['1a86', '0403', '067b', '10c4', '1a87', '1b4f', '2e8a', '2341']);
    const rankedPorts = ports.slice().sort((a, b) => {
      const rank = item => usbSerialVendors.has(String(item.vendorId || '').toLowerCase()) ? 0 : item.vendorId ? 1 : 2;
      return rank(a) - rank(b);
    });
    $('serialUnit').value = 'auto';
    $('serialState').textContent = 'تم العثور على ' + rankedPorts.length + ' منفذ. البرنامج يفحص الكابل والبروتوكول وإعدادات الاتصال تلقائيًا...';
    let lastError = '';
    try {
      for (const port of rankedPorts) {
        for (let index = 0; index < configs.length; index++) {
          if (!autoDetectionEnabled || $('weightMode').value === 'manual') return;
          const config = configs[index];
          autoScanAttemptActive = true;
          autoScanBuffer = '';
          autoScanReadings = [];
          autoScanDetected = null;
          $('serialState').textContent = 'فحص ' + port.path + ' · ' + config.baudRate + ' baud · إعداد ' + (index + 1) + ' من ' + configs.length;
          try {
            await window.desktopBridge.closeSerialPort();
            await window.desktopBridge.openSerialPort({ path: port.path, ...config });
            serialPort = { desktop: true, path: port.path, autoPending: true };
            const waitMs = index < 5 ? 2400 : 1600;
            const deadline = Date.now() + waitMs;
            while (Date.now() < deadline && !autoScanDetected && autoDetectionEnabled) {
              await new Promise(resolve => setTimeout(resolve, 75));
            }
            if (autoScanDetected) {
              const detected = autoScanDetected;
              autoScanAttemptActive = false;
              applyDetectedSerialConfig(port, config, detected);
              autoScanRunning = false;
              autoRetryAt = Date.now() + 60000;
              return;
            }
          } catch (error) {
            lastError = error?.message || String(error);
          }
          try { await window.desktopBridge.closeSerialPort(); } catch (error) { lastError = error?.message || String(error); }
          serialPort = null;
        }
      }
      if (autoDetectionEnabled && $('weightMode').value !== 'manual') {
        $('serialState').textContent = lastError
          ? 'ظهرت منافذ COM لكن لم يتم تأكيد قراءة وزن صحيحة. آخر خطأ: ' + lastError
          : 'تم فحص المنافذ والإعدادات الشائعة، ولم تصل قراءة وزن مؤكدة. اترك الميزان في وضع الإرسال المستمر أو راجع تعريف USB.';
      }
      serialPort = null;
      serialReading = false;
      activeWeightSource = 'waiting';
      autoRetryAt = Date.now() + 20000;
    } finally {
      autoScanAttemptActive = false;
      autoScanRunning = false;
    }
  }

  function applySerialValue(value) {
    if (value === null || !Number.isFinite(value)) return false;
    if (value < 0) {
      $('serialState').textContent = 'قراءة سالبة من المؤشر؛ لم يتم اعتمادها كوزن حمولة.';
      return false;
    }
    if ($('weightMode').value === 'manual') return false;
    activeWeightSource = 'serial';
    rawScaleWeight = Math.min(CAPACITY, value);
    setWeight(rawScaleWeight);
    setStability(true);
    $('serialState').textContent = 'متصل — آخر قراءة: ' + fmt(value) + ' كجم · ' + ($('protocolProfile').selectedOptions[0]?.text || 'Generic');
    return true;
  }
  function consumeDesktopSerialData(data) {
    if ($('serialMode').value === 'continuous' && !/[\r\n\x02\x03]/.test(String(data || ''))) {
      const directValue = parseSerialWeight(data);
      if (directValue !== null) applySerialValue(directValue);
      return;
    }
    if ($('protocolProfile').value === 'yaohua-a9') {
      desktopSerialBuffer += data;
      const extracted = extractYaohuaA9Frames(desktopSerialBuffer);
      desktopSerialBuffer = extracted.rest;
      for (const frame of extracted.frames) {
        const value = parseYaohuaA9Frame(frame);
        if (value !== null) applySerialValue(value);
      }
      return;
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
        if (autoScanRunning) { showToast('انتظر انتهاء البحث التلقائي أولًا.'); return; }
        autoDetectionEnabled = false;
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
        serialPort = { desktop: true, path: selectedPath };
        serialReading = true;
        desktopSerialBuffer = '';
        $('serialState').textContent = 'متصل بالمنفذ ' + selectedPath + ' — في انتظار بيانات الميزان';
        $('serialConnect').disabled = true;
        $('serialDisconnect').disabled = false;
        renderAll();
        showToast('تم فتح منفذ الميزان');
      } catch (error) {
        serialPort = null;
        renderAll();
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
      renderAll();
      showToast('تم الاتصال بالمنفذ. في انتظار بيانات الميزان.');
      readSerial();
    } catch (error) {
      serialPort = null;
      renderAll();
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
    autoDetectionEnabled = false;
    serialReading = false;
    if (desktop && serialPort?.desktop) {
      try { await window.desktopBridge.closeSerialPort(); } catch {}
      serialPort = null;
      $('serialConnect').disabled = false;
      $('serialDisconnect').disabled = true;
      $('serialState').textContent = 'غير متصل — يمكنك إدخال الوزن يدويًا';
      $('sidebarDeviceStatus').textContent = 'بانتظار توصيل الميزان';
      renderAll();
      showToast('تم قطع الاتصال بالميزان');
      return;
    }
    try { if (serialReader) await serialReader.cancel(); } catch {}
    try { if (serialPort) await serialPort.close(); } catch {}
    serialPort = null;
    serialReader = null;
    $('serialConnect').disabled = false;
    $('serialDisconnect').disabled = true;
    $('serialState').textContent = 'غير متصل — يمكنك إدخال الوزن يدويًا';
    $('sidebarDeviceStatus').textContent = 'بانتظار توصيل الميزان';
    renderAll();
    showToast('تم قطع الاتصال بالميزان');
  }
  function excelRowForRecord(r) {
    const original1 = Object.prototype.hasOwnProperty.call(r, 'firstOriginalWeight') ? r.firstOriginalWeight : r.firstWeight;
    const original2 = Object.prototype.hasOwnProperty.call(r, 'secondOriginalWeight') ? r.secondOriginalWeight : r.secondWeight;
    return {
      'رقم التذكرة': r.id, 'نوع الحركة': r.movementType || '—', 'رقم السيارة': r.plate, 'رقم المقطورة': r.trailer || '—',
      'السائق': r.driver, 'العميل': r.customer, 'اسم الشحنة': r.shipment || '—', 'المحافظة': r.governorate || '—',
      'قراءة الأولى الأصلية (كجم)': original1 == null ? 'إدخال يدوي' : original1,
      'الوزن الأول المعتمد (كجم)': r.firstWeight,
      'فرق تعديل الأولى (كجم)': original1 == null ? '' : Number((r.firstWeight - original1).toFixed(2)),
      'قراءة الثانية الأصلية (كجم)': original2 == null ? 'إدخال يدوي' : original2,
      'الوزن الثاني المعتمد (كجم)': r.secondWeight,
      'فرق تعديل الثانية (كجم)': original2 == null ? '' : Number((r.secondWeight - original2).toFixed(2)),
      'صافي الحمولة (كجم)': r.netWeight, 'مصدر الأولى': r.firstSource || r.source,
      'مصدر الثانية': r.secondSource || r.source,
      'وقت الوزنة الأولى': r.firstTime || '', 'وقت الوزنة الثانية': r.secondTime || '',
      'تاريخ العملية': stamp(new Date(r.createdAt))
    };
  }

  function excelColumnName(index) {
    let name = '';
    let value = index + 1;
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function escapeExcelXml(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function joinExcelBytes(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  function crc32Excel(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zipExcelFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const dosDate = 0x0021;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = encoder.encode(file.content);
      const checksum = crc32Excel(data);

      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034B50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, 0, true);
      localView.setUint16(12, dosDate, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, name.length, true);
      localView.setUint16(28, 0, true);
      const localPart = joinExcelBytes([localHeader, name, data]);
      localParts.push(localPart);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014B50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, 0, true);
      centralView.setUint16(14, dosDate, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, localOffset, true);
      centralParts.push(joinExcelBytes([centralHeader, name]));

      localOffset += localPart.length;
    }

    const centralDirectory = joinExcelBytes(centralParts);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054B50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralDirectory.length, true);
    endView.setUint32(16, localOffset, true);
    endView.setUint16(20, 0, true);

    return joinExcelBytes([...localParts, centralDirectory, endRecord]);
  }

  function buildExcelWorkbookBlob(rows, requestedSheetName) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const headers = Object.keys(safeRows[0] || {});
    const table = [headers, ...safeRows.map(row => headers.map(header => row[header]))];
    const lastColumn = excelColumnName(Math.max(0, headers.length - 1));
    const sheetRows = table.map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cellXml = cells.map((value, columnIndex) => {
        const reference = excelColumnName(columnIndex) + rowNumber;
        if (value == null || value === '') return '<c r="' + reference + '"/>';
        if (typeof value === 'number' && Number.isFinite(value)) {
          return '<c r="' + reference + '"><v>' + String(value) + '</v></c>';
        }
        return '<c r="' + reference + '" t="inlineStr"><is><t xml:space="preserve">' +
          escapeExcelXml(value) + '</t></is></c>';
      }).join('');
      return '<row r="' + rowNumber + '">' + cellXml + '</row>';
    }).join('');
    const columns = headers.map((_, index) => {
      const column = index + 1;
      return '<col min="' + column + '" max="' + column + '" width="23" customWidth="1"/>';
    }).join('');
    const sheetName = escapeExcelXml(String(requestedSheetName || 'Sheet1').slice(0, 31));

    const files = [
      {
        name: '[Content_Types].xml',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>'
      },
      {
        name: '_rels/.rels',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>'
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<dimension ref="A1:' + lastColumn + table.length + '"/>' +
          '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
          '<sheetFormatPr defaultRowHeight="18"/><cols>' + columns + '</cols>' +
          '<sheetData>' + sheetRows + '</sheetData>' +
          '<autoFilter ref="A1:' + lastColumn + table.length + '"/>' +
          '</worksheet>'
      }
    ];
    const bytes = zipExcelFiles(files);
    return new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  function downloadExcelBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportTicketExcel(id) {
    const record = records.find(r => r.id === id);
    if (!record) { showToast('لم يتم العثور على المعاملة المطلوبة'); return; }
    if (desktop && window.desktopBridge?.exportExcel) {
      try {
        const result = await window.desktopBridge.exportExcel([record], {
          fileName: 'Weighbridge-Ticket-' + record.id + '.xlsx',
          openAfterExport: true
        });
        if (!result.canceled) showToast('تم تصدير وفتح ملف Excel للتذكرة ' + record.id);
      } catch (error) { showToast('تعذر تصدير ملف Excel: ' + error.message); }
      return;
    }
    if (!window.XLSX) {
      const row = excelRowForRecord(record);
      const blob = buildExcelWorkbookBlob([row], 'بيانات التذكرة');
      downloadExcelBlob(blob, 'Weighbridge-Ticket-' + record.id + '.xlsx');
      showToast('تم تنزيل ملف Excel للتذكرة ' + record.id);
      return;
    }
    const row = excelRowForRecord(record);
    const sheet = XLSX.utils.json_to_sheet([row]);
    sheet['!cols'] = Object.keys(row).map(() => ({ wch: 23 }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'بيانات التذكرة');
    XLSX.writeFile(book, 'Weighbridge-Ticket-' + record.id + '.xlsx');
    showToast('تم تنزيل ملف Excel للتذكرة ' + record.id);
  }

  async function exportExcel() {
    if (!records.length) { showToast('لا توجد عمليات لتصديرها'); return; }
    if (desktop && window.desktopBridge?.exportExcel) {
      try {
        const result = await window.desktopBridge.exportExcel(records);
        if (!result.canceled) showToast('تم تصدير ملف Excel إلى: ' + result.path);
      } catch (error) { showToast('تعذر تصدير Excel: ' + error.message); }
      return;
    }
    if (!window.XLSX) {
      const rows = records.slice().reverse().map(excelRowForRecord);
      const blob = buildExcelWorkbookBlob(rows, 'سجل الوزن');
      downloadExcelBlob(blob, 'Weighbridge-120T-Records-' + dateKey(now()) + '.xlsx');
      showToast('تم تنزيل ملف Excel بنجاح');
      return;
    }
    const rows = records.slice().reverse().map(excelRowForRecord);
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = Object.keys(rows[0]).map(() => ({ wch: 23 }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'سجل الوزن');
    XLSX.writeFile(book, 'Weighbridge-120T-Records-' + dateKey(now()) + '.xlsx');
    showToast('تم تنزيل ملف Excel بنجاح');
  }

  function exportCSV() {
    if(!records.length){showToast('لا توجد عمليات لتصديرها');return;}
    const header=['رقم التذكرة','نوع الحركة','رقم السيارة','رقم المقطورة','اسم العميل','اسم السائق','اسم الشحنة','المحافظة','الوزنة الأولى كجم','الوزنة الثانية كجم','الوزن الصافي كجم','التاريخ'];
    const lines=[header,...records.map(r=>[r.id,r.movementType || '—',r.plate,r.trailer || '—',r.customer,r.driver,r.shipment || '—',r.governorate || '—',r.firstWeight,r.secondWeight,r.netWeight,stamp(new Date(r.createdAt))])];
    const csv='\uFEFF'+lines.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='weighbridge-records.csv';a.click();URL.revokeObjectURL(url);
    showToast('تم تجهيز ملف CSV');
  }

  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.go)));
  $('mobileMenu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('manualWeight').addEventListener('input',()=>{
    $('weightMode').value = 'manual';
    activeWeightSource = 'manual';
    rawScaleWeight = null;
    const raw = $('manualWeight').value;
    if (raw === '') {
      setWeight(0);
      setStability(false);
      $('formMessage').textContent = firstCapture ? 'أدخل قراءة الوزنة الثانية.' : 'أدخل الوزن بالكيلوجرام.';
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > CAPACITY) {
      setStability(false);
      $('formMessage').textContent = 'أدخل وزنًا صحيحًا من 0 إلى 500,000 كجم.';
      return;
    }
    setWeight(value);
    setStability(true);
    $('formMessage').textContent = firstCapture
      ? 'قراءة الوزنة الثانية تتحدث تلقائيًا. اضغط تسجيل الوزنة الثانية عند استقرار الوزن.'
      : 'قراءة الوزن تتحدث تلقائيًا. اضغط تسجيل الوزنة الأولى عند استقرار الوزن.';
  });
  $('weightMode').addEventListener('change',()=>{
    if ($('weightMode').value === 'manual') {
      activeWeightSource = 'manual';
      rawScaleWeight = null;
      $('formMessage').textContent = 'وضع الإدخال اليدوي مفعل. اكتب الوزن وسيتم تحديث القراءة تلقائيًا.';
      $('manualWeight').value = firstCapture && !secondCapture ? '' : liveWeight > 0 ? liveWeight : '';
    } else {
      activeWeightSource = 'waiting';
      rawScaleWeight = null;
      $('formMessage').textContent = serialPort ? 'تم تفعيل القراءة التلقائية؛ انتظر القراءة التالية من الميزان.' : 'وضع التلقائي مفعل؛ وصّل الميزان لقراءة الوزن.';
    }
    $('weightSourceLabel').textContent = activeWeightSource === 'serial' ? 'قراءة من الميزان' : activeWeightSource === 'manual' ? 'إدخال يدوي' : 'بانتظار القراءة';
  });
  $('captureWeight').addEventListener('click',capture);
  $('resetTicket').addEventListener('click',resetTicket);
  $('recordSearch').addEventListener('input',renderRecords);
  $('clearRecordSearch').addEventListener('click',()=>{ $('recordSearch').value=''; renderRecords(); });
  $('reportSearch').addEventListener('input',renderReports);
  $('clearReportSearch').addEventListener('click',()=>{ $('reportSearch').value=''; renderReports(); });
  $('exportRecords').addEventListener('click',exportCSV);
  $('exportExcel').addEventListener('click',exportExcel);
  function setExcelSyncStatus(status) {
    const target = $('excelSyncStatus');
    if (!target) return;
    if (!desktop) {
      target.textContent = 'نسخة الويب: استخدم «تصدير Excel» لتنزيل السجل. الحفظ التلقائي في ملف Excel متاح في نسخة Windows.';
      target.classList.remove('is-error');
      return;
    }
    if (!status) {
      target.textContent = 'جارٍ تجهيز ملف Excel المرتبط...';
      return;
    }
    target.textContent = status.ok
      ? 'مرتبط ويحفظ تلقائيًا · ' + status.path + ' · ' + fmt(status.count) + ' عملية'
      : 'تعذر تحديث ملف Excel: ' + (status.error || 'خطأ غير معروف');
    target.classList.toggle('is-error', !status.ok);
    target.title = status.path || '';
  }
  async function refreshExcelSyncStatus() {
    if (!desktop) {
      setExcelSyncStatus(null);
      $('chooseExcelFile').disabled = true;
      $('openExcelFile').disabled = true;
      return;
    }
    try { setExcelSyncStatus(await window.desktopBridge.getExcelStatus()); }
    catch (error) { setExcelSyncStatus({ ok: false, error: error.message }); }
  }
  $('chooseExcelFile').addEventListener('click', async () => {
    try {
      const result = await window.desktopBridge.chooseExcelFile();
      if (!result.canceled) {
        setExcelSyncStatus(result);
        showToast('تم ربط ملف Excel وسيتم تحديثه تلقائيًا');
      }
    } catch (error) { showToast('تعذر ربط ملف Excel: ' + error.message); }
  });
  $('openExcelFile').addEventListener('click', async () => {
    try {
      const result = await window.desktopBridge.openExcelFile();
      showToast('تم فتح ملف Excel: ' + result.path);
    } catch (error) { showToast('تعذر فتح ملف Excel: ' + error.message); }
  });
  if (desktop) {
    window.desktopBridge.onExcelSyncStatus(setExcelSyncStatus);
    refreshExcelSyncStatus();
  } else {
    setExcelSyncStatus(null);
    $('chooseExcelFile').disabled = true;
    $('openExcelFile').disabled = true;
  }
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
    const refreshPorts = async (force = false) => {
      try {
        const ports = await window.desktopBridge.listSerialPorts();
        const select = $('serialDevice');
        const previous = select.value;
        select.innerHTML = '<option value="">يتم اختيار المنفذ تلقائيًا</option>';
        ports.forEach(port => {
          const option = document.createElement('option');
          option.value = port.path;
          const identity = [port.manufacturer, port.vendorId && ('VID ' + port.vendorId), port.productId && ('PID ' + port.productId)].filter(Boolean).join(' · ');
          option.textContent = port.path + (identity ? ' — ' + identity : '');
          select.appendChild(option);
        });
        if (ports.some(port => port.path === previous)) select.value = previous;
        const signature = ports.map(port => [port.path, port.vendorId || '', port.productId || ''].join(':')).sort().join('|');
        const changed = force || signature !== lastPortsSignature;
        lastPortsSignature = signature;

        if (serialPort?.path && !ports.some(port => port.path === serialPort.path) && !autoScanAttemptActive) {
          autoRetryAt = 0;
          serialPort = null;
          serialReading = false;
          activeWeightSource = 'waiting';
          $('serialConnect').disabled = false;
          $('serialDisconnect').disabled = true;
          $('sidebarDeviceStatus').textContent = 'تم فصل كابل الميزان';
          $('serialState').textContent = 'تم اكتشاف فصل الكابل. البرنامج سيبحث تلقائيًا عند إعادة توصيله.';
          renderAll();
        }

        if (!ports.length) {
          if (!serialPort && !autoScanRunning) $('serialState').textContent = 'بانتظار توصيل كابل الميزان USB أو محول USB-to-RS232...';
          return;
        }
        if (!serialPort && autoDetectionEnabled && $('weightMode').value !== 'manual' && !autoScanRunning &&
            (changed || Date.now() >= autoRetryAt)) {
          autoRetryAt = Date.now() + 20000;
          autoDetectSerialPorts(ports);
        }
      } catch (error) {
        $('serialState').textContent = 'تعذر فحص منافذ USB/COM: ' + error.message;
      }
    };

    $('refreshSerialPorts').addEventListener('click', () => refreshPorts(true));
    $('autoSerialSettings').addEventListener('click', async () => {
      autoDetectionEnabled = true;
      autoRetryAt = 0;
      if (serialPort?.desktop && !serialPort.autoPending) {
        try { await window.desktopBridge.closeSerialPort(); } catch {}
        serialPort = null;
        renderAll();
      }
      await refreshPorts(true);
      if (!autoScanRunning && !serialPort) {
        const ports = await window.desktopBridge.listSerialPorts();
        if (ports.length) autoDetectSerialPorts(ports);
        else $('serialState').textContent = 'لم يظهر منفذ USB/COM. افحص الكابل وتعريف المحول.';
      }
    });
    $('usbHelp').addEventListener('click', async () => {
      await refreshPorts(true);
      showToast('وصل الكابل فقط؛ البرنامج يبحث عن منفذ USB/COM تلقائيًا.');
    });

    window.desktopBridge.onSerialData(data => {
      if (autoScanAttemptActive) consumeAutoScanData(data);
      else consumeDesktopSerialData(data);
    });
    window.desktopBridge.onSerialError(error => {
      if (!autoScanAttemptActive) $('serialState').textContent = 'خطأ في منفذ COM: ' + error;
    });
    window.desktopBridge.onSerialClosed(() => {
      if (autoScanAttemptActive) return;
      serialPort = null;
      serialReading = false;
      if ($('weightMode').value !== 'manual') activeWeightSource = 'waiting';
      if (autoDetectionEnabled) autoRetryAt = 0;
      $('serialConnect').disabled = false;
      $('serialDisconnect').disabled = true;
      $('sidebarDeviceStatus').textContent = 'بانتظار توصيل الميزان';
      $('serialState').textContent = autoDetectionEnabled
        ? 'انقطع اتصال الميزان؛ جاري إعادة الاكتشاف تلقائيًا.'
        : 'تم إغلاق الاتصال اليدوي.';
      renderAll();
    });

    refreshPorts(true);
    setInterval(() => refreshPorts(false), 2000);
  } else {
    $('serialDevice').disabled = true;
    $('refreshSerialPorts').disabled = true;
    $('autoSerialSettings').disabled = true;
    $('serialDevice').innerHTML = '<option>اكتشاف تلقائي للأجهزة متاح في نسخة Windows</option>';
    $('serialState').textContent = 'لأسباب أمان المتصفح، اكتشاف الكابل تلقائيًا متاح في نسخة Windows فقط. استخدم اختيار المنفذ من المتصفح عند الحاجة.';
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
        if ($('weightMode').value !== 'manual') {
          activeWeightSource = 'serial';
          rawScaleWeight = Math.min(CAPACITY, value);
          setWeight(rawScaleWeight); setStability(true);
        }
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
  $('printReport').addEventListener('click',()=>window.print());
  $('closeTicket').addEventListener('click',()=>$('ticketModal').classList.remove('open'));
  $('closeTicket2').addEventListener('click',()=>$('ticketModal').classList.remove('open'));
  $('printTicket').addEventListener('click',()=>window.print());
  $('ticketModal').addEventListener('click',e=>{if(e.target===$('ticketModal'))$('ticketModal').classList.remove('open');});
  document.addEventListener('click',e=>{
    const deleteButton = e.target.closest('[data-delete-record]');
    if (deleteButton) { deleteRecord(deleteButton.dataset.deleteRecord); return; }
    if (e.target.closest('[data-delete-all-records]')) { deleteAllRecords(); return; }
    const exportButton = e.target.closest('[data-export-ticket]');
    if (exportButton) { exportTicketExcel(exportButton.dataset.exportTicket); return; }
    const ticketButton = e.target.closest('[data-ticket]');
    if (ticketButton) { const r=records.find(x=>x.id===ticketButton.dataset.ticket); if(r)openTicket(r); }
  });
  $('saveSettings').addEventListener('click',()=>{settings.systemName=$('systemName').value.trim()||'Weighbridge 120T';writeJSON(SETTINGS_KEY,settings);document.title=settings.systemName+' | نظام إدارة البسكول';$('settingsMessage').textContent='تم حفظ الإعدادات.';showToast('تم حفظ الإعدادات');});
  $('clearData').addEventListener('click',deleteAllRecords);
  $('systemName').value=settings.systemName||'Weighbridge 120T';
  setWeight(liveWeight);setStability(true);updateCaptureUI();renderAll();
})();