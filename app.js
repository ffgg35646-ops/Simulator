(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'weighbridge120t.records.v1';
  const SETTINGS_KEY = 'weighbridge120t.settings.v1';
  const CAPACITY = 500000;
  const desktop = window.desktopBridge && window.desktopBridge.isDesktop;
  let activeUser = null;
  let startSerialMonitoring = null;
  let stopSerialMonitoring = null;
  let serialMonitorTimer = null;
  let records = desktop ? [] : readJSON(STORAGE_KEY, []);
  let settings = readJSON(SETTINGS_KEY, { systemName: 'Weighbridge 120T' });
  let liveWeight = 0;
  let rawScaleWeight = null;
  let isStable = true;
  let activeWeightSource = "waiting";
  let ticketSaved = false;
  let activeRecord = null;
  let editingSupervisorRecordId = null;
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

  const DEVICE_EXPLORER_KEY = 'weighbridge120t.deviceExplorer.v1';
  const savedDeviceExplorer = readJSON(DEVICE_EXPLORER_KEY, {});
  let deviceExplorerPorts = Array.isArray(savedDeviceExplorer.ports) ? savedDeviceExplorer.ports : [];
  let deviceExplorerSamples = Array.isArray(savedDeviceExplorer.samples) ? savedDeviceExplorer.samples : [];
  let deviceExplorerScanAt = savedDeviceExplorer.scanAt || '';
  let deviceExplorerSelectedPath = '';
  let deviceExplorerCaptureActive = false;
  let deviceExplorerRawBuffer = '';
  let deviceExplorerLastProtocol = savedDeviceExplorer.lastProtocol || null;
  let deviceExplorerCurrentConfig = null;
  let deviceExplorerSaveCounter = 0;
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
  function ticketNo() {
    if (desktop && window.desktopBridge?.nextTicketId) {
      const nextId = window.desktopBridge.nextTicketId();
      if (nextId) return String(nextId);
    }
    let id;
    do {
      id = String(Math.floor(100 + Math.random() * 9900));
    } while (records.some(record => String(record.id) === id));
    return id;
  }
  function showToast(message) {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }
  function setWeight(value) {
    liveWeight = Math.max(0, Math.min(CAPACITY, Math.round(Number(value) * 100) / 100));
    $('liveWeight').innerHTML = fmt(liveWeight) + '<span>كجم</span>';
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
    if (ticketSaved) {
      $('formMessage').textContent = 'تم حفظ العملية بالفعل. اضغط «عملية جديدة» لبدء تذكرة أخرى.';
      return;
    }
    const firstRaw = $('firstWeightInput').value.trim();
    const secondRaw = $('secondWeightInput').value.trim();
    if (!firstRaw) {
      $('formMessage').textContent = 'أدخل الوزن الأول.';
      $('firstWeightInput').focus();
      return;
    }
    if (!secondRaw) {
      $('formMessage').textContent = 'أدخل الوزن الثاني.';
      $('secondWeightInput').focus();
      return;
    }
    const firstWeight = Number(firstRaw);
    const secondWeight = Number(secondRaw);
    for (const [label, value, inputId] of [
      ['الأول', firstWeight, 'firstWeightInput'],
      ['الثاني', secondWeight, 'secondWeightInput']
    ]) {
      if (!Number.isFinite(value) || value < 0 || value > CAPACITY) {
        $('formMessage').textContent = 'أدخل الوزن ' + label + ' بقيمة صحيحة من 0 إلى 500,000 كجم.';
        $(inputId).focus();
        return;
      }
    }
    const plate = $('plateInput').value.trim();
    if (!plate) {
      $('formMessage').textContent = 'اكتب رقم السيارة أولًا.';
      $('plateInput').focus();
      return;
    }
    const timestamp = now().toISOString();
    const ticketDetails = {
      plate,
      trailer: $('trailerInput').value.trim() || '—',
      driver: $('driverInput').value.trim() || '—',
      customer: $('customerInput').value.trim() || '—',
      shipment: $('shipmentInput').value.trim() || '—',
      governorate: $('governorateInput').value || '—',
      movementType: $('movementTypeInput').value || 'وارد'
    };
    const acceptedFirstWeight = Math.round(firstWeight * 100) / 100;
    const acceptedSecondWeight = Math.round(secondWeight * 100) / 100;
    const record = {
      id: ticketNo(),
      ...ticketDetails,
      firstWeight: acceptedFirstWeight,
      secondWeight: acceptedSecondWeight,
      firstOriginalWeight: null,
      secondOriginalWeight: null,
      firstAdjusted: false,
      secondAdjusted: false,
      firstSource: 'manual',
      secondSource: 'manual',
      netWeight: Math.round(Math.abs(acceptedFirstWeight - acceptedSecondWeight) * 100) / 100,
      firstTime: timestamp,
      secondTime: timestamp,
      createdAt: timestamp,
      createdByUserId: activeUser?.id || null,
      createdByUserName: activeUser?.displayName || '',
      createdByUsername: activeUser?.username || '',
      source: 'إدخال يدوي'
    };
    records.unshift(record);
    activeRecord = record;
    ticketSaved = true;
    saveRecords();
    $('formMessage').textContent = 'تم حفظ العملية وإصدار البون بنجاح.';
    $('captureWeight').textContent = 'تم الحفظ';
    $('captureWeight').disabled = true;
    showToast('تم حفظ التذكرة');
    openTicket(record);
  }

  function setSupervisorModalDateTime(value = now()) {
    const current = value instanceof Date ? value : new Date(value);
    $('supervisorRecordDate').value = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, '0'),
      String(current.getDate()).padStart(2, '0')
    ].join('-');
    $('supervisorRecordTime').value = [
      String(current.getHours()).padStart(2, '0'),
      String(current.getMinutes()).padStart(2, '0')
    ].join(':');
  }

  function openSupervisorAddModal() {
    if (activeUser?.role !== 'supervisor') return;
    editingSupervisorRecordId = null;
    $('supervisorAddForm').reset();
    $('supervisorAddTitle').textContent = 'إضافة عملية وزن';
    $('supervisorSaveRecord').textContent = 'حفظ وإصدار البون';
    setSupervisorModalDateTime(now());
    updateSupervisorNetPreview();
    $('supervisorFormMessage').textContent = '';
    $('supervisorAddModal').classList.add('open');
    $('supervisorFirstWeight').focus();
  }

  function openSupervisorEditModal(recordId) {
    if (activeUser?.role !== 'supervisor') return;
    const record = records.find(item => String(item.id) === String(recordId));
    if (!record) {
      showToast('السجل المطلوب غير موجود.');
      return;
    }
    editingSupervisorRecordId = String(record.id);
    $('supervisorAddForm').reset();
    $('supervisorAddTitle').textContent = 'تعديل سجل الوزن رقم ' + record.id;
    $('supervisorSaveRecord').textContent = 'حفظ التعديلات وإصدار البون';
    $('supervisorFirstWeight').value = record.firstWeight ?? '';
    $('supervisorSecondWeight').value = record.secondWeight ?? '';
    $('supervisorPlate').value = record.plate || '';
    $('supervisorTrailer').value = record.trailer === '—' ? '' : (record.trailer || '');
    $('supervisorDriver').value = record.driver === '—' ? '' : (record.driver || '');
    $('supervisorCustomer').value = record.customer === '—' ? '' : (record.customer || '');
    $('supervisorShipment').value = record.shipment === '—' ? '' : (record.shipment || '');
    $('supervisorGovernorate').value = record.governorate === '—' ? '' : (record.governorate || '');
    $('supervisorMovementType').value = record.movementType || 'وارد';
    setSupervisorModalDateTime(record.createdAt || now());
    updateSupervisorNetPreview();
    $('supervisorFormMessage').textContent = 'عدّل البيانات المطلوبة ثم احفظ لإعادة إصدار البون وتحديث Excel.';
    $('supervisorAddModal').classList.add('open');
    $('supervisorFirstWeight').focus();
  }

  function closeSupervisorAddModal() {
    $('supervisorAddModal').classList.remove('open');
    editingSupervisorRecordId = null;
    $('supervisorAddTitle').textContent = 'إضافة عملية وزن';
    $('supervisorSaveRecord').textContent = 'حفظ وإصدار البون';
  }

  function updateSupervisorNetPreview() {
    const firstRaw = $('supervisorFirstWeight').value.trim();
    const secondRaw = $('supervisorSecondWeight').value.trim();
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    const valid = Boolean(firstRaw && secondRaw) &&
      Number.isFinite(first) && Number.isFinite(second) &&
      first >= 0 && second >= 0 && first <= CAPACITY && second <= CAPACITY;
    $('supervisorNetCaptureBox').hidden = !valid;
    $('supervisorNetWeight').textContent = valid
      ? fmt(Math.round(Math.abs(first - second) * 100) / 100) + ' كجم'
      : '—';
  }

  async function captureSupervisorRecord() {
    const message = $('supervisorFormMessage');
    const firstRaw = $('supervisorFirstWeight').value.trim();
    const secondRaw = $('supervisorSecondWeight').value.trim();
    if (!firstRaw || !secondRaw) {
      message.textContent = 'أدخل الوزنة الأولى والثانية.';
      return;
    }
    const firstWeight = Number(firstRaw);
    const secondWeight = Number(secondRaw);
    for (const [label, value, inputId] of [
      ['الأولى', firstWeight, 'supervisorFirstWeight'],
      ['الثانية', secondWeight, 'supervisorSecondWeight']
    ]) {
      if (!Number.isFinite(value) || value < 0 || value > CAPACITY) {
        message.textContent = 'أدخل الوزنة ' + label + ' بقيمة صحيحة من 0 إلى 500,000 كجم.';
        $(inputId).focus();
        return;
      }
    }
    const plate = $('supervisorPlate').value.trim();
    if (!plate) {
      message.textContent = 'اكتب رقم السيارة أولًا.';
      $('supervisorPlate').focus();
      return;
    }
    const dateValue = $('supervisorRecordDate').value;
    const timeValue = $('supervisorRecordTime').value;
    if (!dateValue || !timeValue) {
      message.textContent = 'حدد تاريخ ووقت العملية.';
      return;
    }
    const operationDate = new Date(dateValue + 'T' + timeValue + ':00');
    if (!Number.isFinite(operationDate.getTime())) {
      message.textContent = 'تاريخ أو وقت العملية غير صحيح.';
      return;
    }
    const timestamp = operationDate.toISOString();
    const acceptedFirstWeight = Math.round(firstWeight * 100) / 100;
    const acceptedSecondWeight = Math.round(secondWeight * 100) / 100;
    const isEditing = Boolean(editingSupervisorRecordId);
    const existingRecord = isEditing
      ? records.find(item => String(item.id) === String(editingSupervisorRecordId))
      : null;
    if (isEditing && !existingRecord) {
      message.textContent = 'السجل المطلوب تعديله غير موجود. أغلق النافذة وحدّث السجلات.';
      return;
    }
    const record = {
      ...(existingRecord || {}),
      id: existingRecord?.id || ticketNo(),
      plate,
      trailer: $('supervisorTrailer').value.trim() || '—',
      driver: $('supervisorDriver').value.trim() || '—',
      customer: $('supervisorCustomer').value.trim() || '—',
      shipment: $('supervisorShipment').value.trim() || '—',
      governorate: $('supervisorGovernorate').value || '—',
      movementType: $('supervisorMovementType').value || 'وارد',
      firstWeight: acceptedFirstWeight,
      secondWeight: acceptedSecondWeight,
      netWeight: Math.round(Math.abs(acceptedFirstWeight - acceptedSecondWeight) * 100) / 100,
      firstTime: timestamp,
      secondTime: timestamp,
      createdAt: timestamp,
      createdByUserId: existingRecord?.createdByUserId || activeUser?.id || null,
      createdByUserName: existingRecord?.createdByUserName || activeUser?.displayName || '',
      createdByUsername: existingRecord?.createdByUsername || activeUser?.username || activeUser?.email || '',
      source: existingRecord?.source || 'إضافة المشرف'
    };
    const submit = $('supervisorSaveRecord');
    submit.disabled = true;
    message.textContent = isEditing ? 'جارٍ حفظ التعديلات وتحديث Excel...' : 'جارٍ حفظ العملية...';
    try {
      let savedRecord;
      let excelSync = null;
      if (isEditing) {
        const result = await window.desktopBridge.updateSupervisorRecord(record.id, record);
        savedRecord = result.record;
        excelSync = result.excelSync || null;
      } else {
        savedRecord = await window.desktopBridge.addSupervisorRecord(record);
      }
      records = readJSON(STORAGE_KEY, []);
      activeRecord = savedRecord;
      renderAll();
      closeSupervisorAddModal();
      $('supervisorAddForm').reset();
      if (isEditing && excelSync?.ok === false) {
        showToast('تم تعديل السجل وإصدار البون، لكن تعذر تحديث ملف Excel');
      } else if (isEditing) {
        showToast('تم تعديل السجل وتحديث Excel وإصدار البون');
      } else {
        showToast('تم حفظ العملية وإصدار البون');
      }
      openTicket(savedRecord);
    } catch (error) {
      message.textContent = error.message || (isEditing ? 'تعذر تعديل السجل.' : 'تعذر حفظ العملية.');
    } finally {
      submit.disabled = false;
    }
  }

  function updateCaptureUI() {
    const firstRaw = $('firstWeightInput').value.trim();
    const secondRaw = $('secondWeightInput').value.trim();
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    const valid = Boolean(firstRaw && secondRaw) &&
      Number.isFinite(first) && Number.isFinite(second) &&
      first >= 0 && second >= 0 && first <= CAPACITY && second <= CAPACITY;
    $('netCaptureBox').hidden = !valid;
    $('netWeight').textContent = valid
      ? fmt(Math.round(Math.abs(first - second) * 100) / 100) + ' كجم'
      : '—';
    if (!ticketSaved) {
      $('captureWeight').disabled = false;
      $('captureWeight').textContent = 'حفظ';
    }
  }
  function resetTicket() {
    ticketSaved = false;
    $('firstWeightInput').value = '';
    $('secondWeightInput').value = '';
    $('formMessage').textContent = '';
    $('plateInput').value = '';
    $('trailerInput').value = '';
    $('driverInput').value = '';
    $('customerInput').value = '';
    $('shipmentInput').value = '';
    $('governorateInput').value = '';
    $('movementTypeInput').value = 'وارد';
    updateCaptureUI();
    $('plateInput').focus();
  }
  function printTicketOnly() {
    const body = document.body;
    const cleanup = () => body.classList.remove('printing-ticket');

    body.classList.add('printing-ticket');
    window.addEventListener('afterprint', cleanup, { once: true });

    try {
      window.print();
    } catch (error) {
      window.removeEventListener('afterprint', cleanup);
      cleanup();
      showToast('تعذر فتح نافذة طباعة التذكرة.');
    }
  }

  function openTicket(record) {
    activeRecord = record;
    $('ticketContent').innerHTML = ticketMarkup(record);
    $('ticketModal').classList.add('open');
  }
  function ticketMarkup(r) {
    return '<div class="ticket-paper"><div class="ticket-location">مدينة السادات<br>المدفن الصحي</div>' +
      '<div class="ticket-top-grid">' +
      ticketField('اسم العميل',r.customer) + ticketField('اسم السائق',r.driver) + ticketField('نوع الحركة',r.movementType || '—') +
      ticketField('رقم السيارة',r.plate) + ticketField('رقم المقطورة',r.trailer || '—') + ticketField('المحافظة',r.governorate || '—') +
      '</div><div class="ticket-bottom-grid">' +
      ticketField('اسم الشحنة',r.shipment || '—') + ticketField('تاريخ العملية',stamp(new Date(r.createdAt))) +
      ticketField('الوزنة الأولى',fmt(r.firstWeight)+' كجم') + ticketField('الوزنة الثانية',fmt(r.secondWeight)+' كجم') +
      '</div><div class="ticket-net"><small>صافي الحمولة</small><strong>' + fmt(r.netWeight) + ' كجم</strong></div></div>';
  }
  function ticketField(label, value) { return '<div class="ticket-field"><small>'+esc(label)+'</small><strong>'+esc(String(value))+'</strong></div>'; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  const explorerUsbVendors = {
    '1a86': 'QinHeng / CH340-CH341',
    '0403': 'FTDI',
    '067b': 'Prolific PL2303',
    '10c4': 'Silicon Labs CP210x',
    '2341': 'Arduino USB Serial',
    '2e8a': 'Raspberry Pi / RP2040',
    '1b4f': 'SparkFun USB Serial'
  };
  function explorerHexId(value) {
    if (value === undefined || value === null || value === '') return '—';
    const clean = typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value).toString(16)
      : String(value).replace(/^0x/i, '').toLowerCase();
    return clean ? clean.padStart(4, '0') : '—';
  }
  function explorerPortVendor(port) {
    const vendorId = explorerHexId(port.vendorId);
    return explorerUsbVendors[vendorId] || port.manufacturer || (port.pnpId ? 'جهاز USB غير محدد' : 'منفذ تسلسلي');
  }
  function explorerPortType(port) {
    const vendorId = explorerHexId(port.vendorId);
    if (explorerUsbVendors[vendorId]) return 'USB-Serial';
    if (port.vendorId || port.productId || /USB/i.test(String(port.pnpId || ''))) return 'USB غير معروف';
    return 'Serial';
  }
  function saveDeviceExplorerState() {
    try {
      writeJSON(DEVICE_EXPLORER_KEY, {
        ports: deviceExplorerPorts,
        samples: deviceExplorerSamples,
        scanAt: deviceExplorerScanAt,
        lastProtocol: deviceExplorerLastProtocol
      });
    } catch (error) {
      const message = $('explorerCaptureMessage');
      if (message) message.textContent = 'تعذر حفظ سجل التشخيص محليًا: ' + (error?.message || String(error));
    }
  }
  function renderDeviceExplorerPorts() {
    const body = $('explorerPortsTable');
    if (!body) return;
    $('explorerPortCount').textContent = String(deviceExplorerPorts.length);
    $('explorerUsbCount').textContent = String(deviceExplorerPorts.filter(port => explorerPortType(port) === 'USB-Serial').length);
    $('explorerDeviceStatus').textContent = deviceExplorerPorts.length ? 'تم اكتشاف ' + deviceExplorerPorts.length + ' منفذ' : 'لا توجد منافذ';
    $('explorerLastScan').textContent = deviceExplorerScanAt
      ? 'آخر فحص: ' + stamp(new Date(deviceExplorerScanAt))
      : 'لم يتم إجراء فحص بعد.';
    if (!deviceExplorerPorts.some(port => port.path === deviceExplorerSelectedPath)) {
      deviceExplorerSelectedPath = deviceExplorerPorts[0]?.path || '';
    }
    if (!deviceExplorerPorts.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">لم يتم العثور على منفذ متاح. افحص الكابل وتعريف المحول ثم أعد الفحص.</td></tr>';
      renderDeviceExplorerSelected();
      return;
    }
    body.innerHTML = deviceExplorerPorts.map(port => {
      const path = String(port.path || 'Serial');
      const vendor = explorerPortVendor(port);
      const vid = explorerHexId(port.vendorId);
      const pid = explorerHexId(port.productId);
      const isSelected = path === deviceExplorerSelectedPath;
      const connected = Boolean(serialPort && serialPort.path === path && !serialPort.autoPending);
      const kind = explorerPortType(port);
      return '<tr class="' + (isSelected ? 'explorer-selected-row' : '') + '">' +
        '<td><button class="table-action explorer-select-port" type="button" data-explorer-port="' + esc(path) + '">' + esc(path) + '</button>' +
        (connected ? '<span class="explorer-subtext">اتصال الميزان الحالي</span>' : '') + '</td>' +
        '<td><span class="explorer-vendor">' + esc(vendor) + '</span><span class="explorer-subtext">' + esc(port.friendlyName || port.pnpId || 'لا يوجد وصف إضافي من نظام التشغيل') + '</span></td>' +
        '<td><span dir="ltr">' + esc(vid) + ' : ' + esc(pid) + '</span></td>' +
        '<td>' + esc(port.serialNumber || 'غير متاح') + '</td>' +
        '<td><span class="explorer-type-tag ' + (kind === 'USB-Serial' ? '' : 'unknown') + '">' + esc(kind) + '</span></td>' +
        '<td><button class="table-action" type="button" data-explorer-port="' + esc(path) + '">عرض</button></td>' +
        '</tr>';
    }).join('');
    renderDeviceExplorerSelected();
  }
  function renderDeviceExplorerSelected() {
    const host = $('explorerSelectedDevice');
    if (!host) return;
    const port = deviceExplorerPorts.find(item => item.path === deviceExplorerSelectedPath);
    if (!port) {
      host.innerHTML = '<div class="explorer-empty-state"><div class="explorer-empty-icon">⌁</div><strong>لم يتم اختيار جهاز</strong><span>نفّذ الفحص ثم اختر أحد المنافذ من الجدول.</span></div>';
      $('explorerSelectedBadge').textContent = 'لا يوجد تحديد';
      return;
    }
    const connected = Boolean(serialPort && serialPort.path === port.path && !serialPort.autoPending);
    $('explorerSelectedBadge').textContent = connected ? 'متصل حاليًا' : 'منفذ مكتشف';
    host.innerHTML = [
      ['المنفذ', port.path || 'غير معروف'],
      ['الشركة / الشريحة', explorerPortVendor(port)],
      ['معرّف VID', explorerHexId(port.vendorId)],
      ['معرّف PID', explorerHexId(port.productId)],
      ['الرقم التسلسلي', port.serialNumber || 'غير متاح'],
      ['معرّف PnP', port.pnpId || 'غير متاح'],
      ['موقع الجهاز', port.locationId || 'غير متاح'],
      ['الحالة', connected ? 'اتصال مستخدم حاليًا' : 'مكتشف — ليس بالضرورة متصلًا بالمؤشر']
    ].map(item => '<div><small>' + esc(item[0]) + '</small><strong>' + esc(String(item[1])) + '</strong></div>').join('');
  }
  function renderDeviceExplorerProtocol() {
    const info = deviceExplorerLastProtocol;
    if (!info) {
      $('explorerProtocolName').textContent = 'لم يتم التعرف عليه بعد';
      $('explorerProtocolDescription').textContent = 'يلزم استقبال بيانات فعلية من مؤشر الميزان قبل تحديد تنسيق الرسائل.';
      $('explorerProtocolBadge').textContent = 'لم تصل بيانات';
      $('explorerProtocolConfidence').textContent = '—';
      $('explorerProtocolWeight').textContent = '—';
      $('explorerProtocolPort').textContent = '—';
      return;
    }
    $('explorerProtocolName').textContent = info.name;
    $('explorerProtocolDescription').textContent = info.description;
    $('explorerProtocolBadge').textContent = info.confidence;
    $('explorerProtocolConfidence').textContent = info.confidence;
    $('explorerProtocolWeight').textContent = info.weight == null ? 'لا توجد قراءة' : fmt(info.weight) + ' كجم';
    $('explorerProtocolPort').textContent = info.port || 'غير معروف';
  }
  function renderDeviceExplorerSamples() {
    $('explorerSampleCount').textContent = String(deviceExplorerSamples.length);
    const body = $('explorerSamplesTable');
    if (!body) return;
    if (!deviceExplorerSamples.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">لم يتم تسجيل عينات بعد.</td></tr>';
    } else {
      body.innerHTML = deviceExplorerSamples.slice(-35).reverse().map(sample => {
        const time = sample.at ? stamp(new Date(sample.at)) : '—';
        const config = sample.config ? sample.config.baudRate + ' / ' + sample.config.dataBits + sample.config.parity + sample.config.stopBits : 'غير محدد';
        return '<tr><td>' + esc(time) + '</td><td>' + esc(sample.port || '—') + '</td><td><span dir="ltr">' + esc(config) + '</span></td><td>' + esc(sample.protocol || 'غير معروف') + '</td><td>' + (sample.weight == null ? '—' : esc(fmt(sample.weight)) + ' كجم') + '</td><td title="' + esc(sample.raw || '') + '">' + esc(sample.preview || '') + '</td></tr>';
      }).join('');
    }
    const last = deviceExplorerSamples[deviceExplorerSamples.length - 1];
    if (last) {
      const hexPreview = last.hex ? last.hex.match(/.{1,2}/g).slice(0, 160).join(' ') : 'غير متاح';
      $('explorerRawPreview').textContent = (last.readable || 'وصلت بيانات غير قابلة للعرض النصي.') + '\\nHEX: ' + hexPreview;
      $('explorerRawSize').textContent = (last.rawLength || 0) + ' بايت';
    } else {
      $('explorerRawPreview').textContent = 'لا توجد بيانات مستقبلة حتى الآن.';
      $('explorerRawSize').textContent = '0 حرف';
    }
    renderDeviceExplorerProtocol();
  }
  function renderDeviceExplorerCaptureStatus() {
    $('explorerCaptureStatus').textContent = deviceExplorerCaptureActive ? 'يسجل الآن' : 'متوقف';
    $('explorerCaptureStatus').classList.toggle('is-active', deviceExplorerCaptureActive);
    $('explorerCaptureHint').textContent = deviceExplorerCaptureActive ? 'تُحفظ البيانات الواردة' : 'لا يتم تسجيل بيانات حاليًا';
    $('explorerCaptureStart').disabled = deviceExplorerCaptureActive;
    $('explorerCaptureStop').disabled = !deviceExplorerCaptureActive;
    if (deviceExplorerCaptureActive) {
      $('explorerCaptureMessage').textContent = (serialPort || autoScanRunning)
        ? 'التسجيل نشط. كل البيانات الواردة من محاولة الاتصال الحالية تُضاف إلى سجل التشخيص.'
        : 'التسجيل في وضع الانتظار. اذهب إلى «الاتصال بالأجهزة» وشغّل البحث التلقائي أو الاتصال اليدوي لبدء استقبال العينات.';
    }
  }
  function classifyExplorerProtocol(raw, latestChunk = raw) {
    const data = String(raw || '');
    const current = String(latestChunk || '');
    const stx = String.fromCharCode(0x02);
    const etx = String.fromCharCode(0x03);
    const extracted = extractYaohuaA9Frames(data);
    for (const frame of extracted.frames) {
      const value = parseYaohuaA9Frame(frame);
      if (value !== null) {
        return { name: 'YAOHUA XK3190-A9 / A9+', description: 'إطار بطول 12 بايت مع STX وETX وفحص XOR؛ تم التحقق من إطار وزن مطابق.', confidence: 'مرتفع — توقيع إطار مطابق', weight: value };
      }
    }
    if (data.includes(stx) && data.includes(etx)) {
      const frames = data.split(etx).filter(frame => frame.includes(stx));
      const latestFrame = frames[frames.length - 1] || data;
      const inner = latestFrame.slice(latestFrame.indexOf(stx) + 1).replace(/[\x00-\x1f]/g, ' ').trim();
      const value = parseSerialWeight(inner);
      return { name: 'إطار STX / ETX', description: value === null ? 'تم رصد علامات بداية ونهاية إطار، لكن لم يتم استخراج رقم وزن صالح.' : 'تم رصد إطار STX/ETX يحتوي على قيمة رقمية قابلة للقراءة. هذا وصف للتنسيق وليس اسم شركة محددًا.', confidence: value === null ? 'مبدئي — إطار غير مكتمل' : 'متوسط — تنسيق إطار معروف', weight: value };
    }
    const completeLines = data.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    let value = null;
    for (let index = completeLines.length - 1; index >= 0 && value === null; index--) {
      value = parseSerialWeight(completeLines[index]);
    }
    const currentClean = current.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim();
    if (value === null && !/[\r\n]/.test(data)) value = parseSerialWeight(currentClean);
    if (value !== null && /[\r\n]/.test(data)) {
      return { name: 'ASCII نصي — CR / LF', description: 'بيانات نصية تحتوي على رقم وزن وفواصل أسطر. هذا تنسيق شائع، ولا يحدد الشركة المصنعة للمؤشر.', confidence: 'متوسط — نمط نصي قابل للقراءة', weight: value };
    }
    if (value !== null) {
      return { name: 'ASCII Continuous Stream', description: 'تدفق نصي مستمر يحتوي على قيمة رقمية. يلزم تجميع عدة عينات ومقارنة توقيت الرسائل للتأكد.', confidence: 'مبدئي — عينة رقمية واحدة', weight: value };
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(data)) {
      return { name: 'بيانات ثنائية / بروتوكول غير معروف', description: 'تم استقبال محارف تحكم أو بيانات غير نصية. تم حفظ العينة الخام للمراجعة، ولا يمكن تسمية البروتوكول بدقة من هذه العينة وحدها.', confidence: 'غير معروف', weight: null };
    }
    return { name: 'بروتوكول غير معروف', description: 'وصلت بيانات، لكن شكلها لا يطابق التنسيقات النصية والإطارات المعروفة حاليًا. تم حفظ العينة كما وردت.', confidence: 'غير معروف — يحتاج تحليل', weight: null };
  }
  function explorerReadableData(data) {
    return String(data || '').replace(/\r/g, '\\r').replace(/\n/g, '\\n\n').replace(/\t/g, '\\t')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ch => '\\x' + (ch.charCodeAt(0) & 255).toString(16).padStart(2, '0'));
  }
  function recordDeviceExplorerData(data) {
    if (!deviceExplorerCaptureActive) return;
    const payload = data && typeof data === 'object' ? data : { text: String(data ?? '') };
    const raw = String(payload.text ?? '');
    if (!raw && !payload.hex && !payload.base64) return;
    deviceExplorerRawBuffer = (deviceExplorerRawBuffer + raw).slice(-2048);
    const detected = classifyExplorerProtocol(deviceExplorerRawBuffer, raw);
    const weight = detected.weight;
    const config = deviceExplorerCurrentConfig || {
      baudRate: Number($('serialBaud')?.value || 0),
      dataBits: Number($('serialDataBits')?.value || 8),
      parity: $('serialParity')?.value || 'none',
      stopBits: Number($('serialStopBits')?.value || 1)
    };
    const portPath = deviceExplorerCurrentConfig?.path || serialPort?.path || $('serialDevice')?.value || 'COM غير محدد';
    const preview = explorerReadableData(raw).slice(0, 220);
    const sample = {
      at: new Date().toISOString(),
      port: portPath,
      config: { baudRate: config.baudRate, dataBits: config.dataBits, parity: config.parity, stopBits: config.stopBits },
      protocol: detected.name,
      confidence: detected.confidence,
      weight,
      rawLength: Number(payload.byteLength ?? raw.length),
      raw: raw.slice(0, 1500),
      hex: String(payload.hex || ''),
      base64: String(payload.base64 || ''),
      readable: explorerReadableData(raw).slice(0, 1200),
      preview
    };
    deviceExplorerSamples.push(sample);
    if (deviceExplorerSamples.length > 2000) deviceExplorerSamples.splice(0, deviceExplorerSamples.length - 2000);
    deviceExplorerLastProtocol = { ...detected, port: portPath };
    deviceExplorerSaveCounter++;
    if (deviceExplorerSaveCounter >= 5) {
      deviceExplorerSaveCounter = 0;
      saveDeviceExplorerState();
    }
    if ($('view-devices')?.classList.contains('active')) renderDeviceExplorerSamples();
  }
  async function refreshDeviceExplorerPorts(showMessage = true) {
    const status = $('explorerDeviceStatus');
    if (!status) return;
    status.textContent = 'جارٍ فحص المنافذ...';
    try {
      let ports = [];
      if (desktop && window.desktopBridge?.listSerialPorts) {
        ports = await window.desktopBridge.listSerialPorts();
      } else if (navigator.serial?.getPorts) {
        const browserPorts = await navigator.serial.getPorts();
        ports = browserPorts.map((port, index) => {
          const info = port.getInfo ? port.getInfo() : {};
          return { path: 'منفذ متاح للمتصفح ' + (index + 1), vendorId: info.usbVendorId, productId: info.usbProductId, manufacturer: 'USB Serial (Web Serial)' };
        });
      } else {
        deviceExplorerPorts = [];
        status.textContent = 'اكتشاف المنافذ متاح في نسخة Windows';
        $('explorerRuntimeStatus').textContent = 'نسخة الويب';
        renderDeviceExplorerPorts();
        $('explorerCaptureMessage').textContent = 'المتصفح لا يتيح قائمة المنافذ تلقائيًا. استخدم نسخة Windows لتشخيص أجهزة USB وCOM دون طلب صلاحيات منفصلة لكل جهاز.';
        return;
      }
      deviceExplorerPorts = ports.map(port => ({
        path: String(port.path || 'Serial'),
        manufacturer: port.manufacturer || '',
        vendorId: port.vendorId || '',
        productId: port.productId || '',
        serialNumber: port.serialNumber || '',
        pnpId: port.pnpId || '',
        locationId: port.locationId || '',
        friendlyName: port.friendlyName || ''
      }));
      deviceExplorerScanAt = new Date().toISOString();
      saveDeviceExplorerState();
      $('explorerRuntimeStatus').textContent = desktop ? 'نسخة Windows Desktop' : 'Web Serial';
      renderDeviceExplorerPorts();
      if (showMessage) {
        $('explorerCaptureMessage').textContent = deviceExplorerPorts.length
          ? 'اكتمل الفحص. اختر منفذًا لمراجعة بياناته، ثم ابدأ تسجيل البيانات قبل تشغيل البحث التلقائي من صفحة الاتصال.'
          : 'لم يظهر أي منفذ COM/Serial. هذا لا يمنع تشغيل البرنامج أو تسجيل الوزن يدويًا.';
      }
    } catch (error) {
      status.textContent = 'تعذر فحص المنافذ';
      $('explorerCaptureMessage').textContent = 'حدث خطأ أثناء فحص الأجهزة: ' + (error?.message || String(error));
    }
  }
  function exportDeviceExplorerReport() {
    const report = {
      application: 'Weighbridge 120T',
      generatedAt: new Date().toISOString(),
      runtime: desktop ? 'Windows Desktop' : 'Web',
      lastScanAt: deviceExplorerScanAt,
      detectedPorts: deviceExplorerPorts,
      lastProtocolDetection: deviceExplorerLastProtocol,
      capturedSamples: deviceExplorerSamples,
      note: 'USB vendor/chipset identity does not by itself prove the scale indicator protocol. Windows samples include the UTF-8 text and original serial bytes as HEX/Base64; Web Serial samples include the bytes exposed by the browser.'
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'weighbridge-device-diagnostic-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('تم تجهيز تقرير تشخيص الأجهزة والبروتوكول');
  }
  function startDeviceExplorerCapture() {
    deviceExplorerCaptureActive = true;
    deviceExplorerRawBuffer = '';
    renderDeviceExplorerCaptureStatus();
    $('explorerCaptureMessage').textContent = serialPort || autoScanRunning
      ? 'بدأ التسجيل من الاتصال الحالي. يتم حفظ العينات الواردة بالتتابع.'
      : 'تم تفعيل وضع الانتظار. انتقل إلى «الاتصال بالأجهزة» وشغّل البحث التلقائي أو الاتصال اليدوي؛ المستكشف سيسجل كل عينة واردة دون تغيير منطق الاتصال.';
  }
  function stopDeviceExplorerCapture() {
    deviceExplorerCaptureActive = false;
    deviceExplorerSaveCounter = 0;
    saveDeviceExplorerState();
    renderDeviceExplorerCaptureStatus();
    $('explorerCaptureMessage').textContent = 'تم إيقاف التسجيل وحفظ العينات المسجلة محليًا. يمكنك تصدير تقرير التشخيص لإرساله للمراجعة.';
  }
  function renderDeviceExplorer() {
    renderDeviceExplorerPorts();
    renderDeviceExplorerSamples();
    renderDeviceExplorerCaptureStatus();
  }

  function rowMarkup(r, detailed = false) {
    const movement = esc(r.movementType || '—');
    const ownerCell = activeUser?.role === 'supervisor'
      ? '<td>'+esc(r.createdByUserName || 'غير محدد')+'</td>'
      : '';
    const editAction = activeUser?.role === 'supervisor'
      ? '<button class="table-action" data-edit-record="'+esc(r.id)+'">تعديل</button>'
      : '';
    const deleteAction = activeUser?.role === 'supervisor'
      ? ''
      : '<button class="table-action delete-row-action" data-delete-record="'+esc(r.id)+'">حذف</button>';
    const cells = detailed
      ? '<td><strong>'+esc(r.id)+'</strong></td>' + ownerCell + '<td>'+movement+'</td><td>'+esc(r.plate)+'</td><td>'+esc(r.trailer || '—')+'</td>' +
        '<td>'+esc(r.driver)+'</td><td>'+esc(r.customer)+'</td><td>'+esc(r.shipment || '—')+'</td><td>'+esc(r.governorate || '—')+'</td>' +
        '<td>'+fmt(r.firstWeight)+'</td><td>'+fmt(r.secondWeight)+'</td><td><strong class="net-cell">'+fmt(r.netWeight)+'</strong></td><td>'+stamp(new Date(r.createdAt))+'</td>' +
        '<td><div class="table-actions">'+editAction+'<button class="table-action" data-ticket="'+esc(r.id)+'">التذكرة</button><button class="table-action" data-export-ticket="'+esc(r.id)+'">تصدير Excel</button>'+deleteAction+'</div></td>'
      : '<td><strong>'+esc(r.id)+'</strong></td><td>'+movement+'</td><td>'+esc(r.plate)+'</td><td>'+esc(r.trailer || '—')+'</td>' +
        '<td>'+esc(r.customer)+'</td><td>'+esc(r.driver)+'</td><td>'+esc(r.shipment || '—')+'</td><td><strong class="net-cell">'+fmt(r.netWeight)+'</strong></td><td>'+stamp(new Date(r.createdAt))+'</td>' +
        '<td><div class="table-actions">'+editAction+'<button class="table-action" data-export-ticket="'+esc(r.id)+'">تصدير ملف Excel</button></div></td>';
    return '<tr>'+cells+'</tr>';
  }
  function searchRecords(query, sourceRecords = records) {
    const q = String(query || '').trim().toLocaleLowerCase('ar');
    if (!q) return sourceRecords.slice();
    return sourceRecords.filter(r => {
      const values = [
        r.id, r.movementType, r.plate, r.trailer, r.driver, r.customer, r.shipment, r.governorate, r.source, r.firstSource, r.secondSource,
        r.firstWeight, r.secondWeight, r.netWeight, r.firstOriginalWeight, r.secondOriginalWeight,
        r.createdAt, r.firstTime, r.secondTime, r.createdByUserName, r.createdByUsername,
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
    const scopeText = activeUser?.role === 'operator' ? 'سجلات هذا المستخدم فقط' : 'جميع السجلات';
    if (!confirm('تحذير: سيتم حذف ' + scopeText + ' (' + count + ' عملية) نهائيًا. هل تريد المتابعة؟')) return;
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
    const ownerFilter = activeUser?.role === 'supervisor' ? ($('supervisorReportFilter')?.value || 'all') : 'all';
    const reportSource = ownerFilter === 'all'
      ? records
      : records.filter(record => record.createdByUserId === ownerFilter);
    const filtered = reportSource.slice();
    const total = filtered.reduce((s,r)=>s+r.netWeight,0);
    $('reportCount').textContent = fmt(filtered.length);
    $('reportNet').textContent = fmt(total)+' كجم';
    $('reportAverage').textContent = fmt(filtered.length ? Math.round(total/filtered.length) : 0)+' كجم';
    const emptyColumns = activeUser?.role === 'supervisor' ? 14 : 13;
    $('reportRecordsTable').innerHTML = filtered.length ? filtered.map(r=>rowMarkup(r,true)).join('') : '<tr class="empty-row"><td colspan="'+emptyColumns+'">'+(reportSource.length ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد عمليات مسجلة')+'</td></tr>';
  }
  function switchView(name) {
    // Operator accounts are intentionally limited to the single operating screen.
    if (activeUser?.role === 'operator' && name !== 'dashboard') name = 'dashboard';
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+name));
    document.querySelectorAll('.nav-link').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
    const titles={dashboard:'لوحة التشغيل',weighings:'سجل عمليات الوزن',vehicles:'السيارات والعملاء',reports:'التقارير والإحصائيات',devices:'الأجهزة والاتصال'};
    $('pageTitle').textContent=titles[name]||'لوحة التشغيل';
    $('sidebar').classList.remove('open');
    if(name==='weighings')renderRecords();
    if(name==='devices')refreshDeviceExplorerPorts(false);
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
          deviceExplorerCurrentConfig = { path: port.path, ...config };
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
        deviceExplorerCurrentConfig = {
          path: selectedPath,
          baudRate: Number($('serialBaud').value),
          dataBits: Number($('serialDataBits').value),
          stopBits: Number($('serialStopBits').value),
          parity: $('serialParity').value,
          flowControl: $('serialFlow').value
        };
        await window.desktopBridge.openSerialPort(deviceExplorerCurrentConfig);
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
      deviceExplorerCurrentConfig = { path: 'Web Serial', baudRate: Number($('serialBaud').value), dataBits: Number($('serialDataBits').value), stopBits: Number($('serialStopBits').value), parity: $('serialParity').value, flowControl: $('serialFlow').value };
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: deviceExplorerCurrentConfig.baudRate, dataBits: deviceExplorerCurrentConfig.dataBits, stopBits: deviceExplorerCurrentConfig.stopBits, parity: deviceExplorerCurrentConfig.parity, flowControl: deviceExplorerCurrentConfig.flowControl });
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
          const incoming = new TextDecoder().decode(result.value);
          const bytes = Array.from(result.value);
          let base64 = '';
          try { base64 = btoa(bytes.map(byte => String.fromCharCode(byte)).join('')); } catch {}
          recordDeviceExplorerData({ text: incoming, byteLength: bytes.length, hex: bytes.map(byte => byte.toString(16).padStart(2, '0')).join(''), base64 });
          buffer += incoming;
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

  function getReportExportRecords() {
    if (activeUser?.role !== 'supervisor') return records.slice();
    const ownerFilter = $('supervisorReportFilter')?.value || 'all';
    return ownerFilter === 'all' ? records.slice() : records.filter(record => record.createdByUserId === ownerFilter);
  }

  async function exportExcel() {
    const exportRecords = getReportExportRecords();
    if (!exportRecords.length) { showToast('لا توجد عمليات لتصديرها'); return; }
    if (desktop && window.desktopBridge?.exportExcel) {
      try {
        const result = await window.desktopBridge.exportExcel(exportRecords);
        if (!result.canceled) showToast('تم تصدير ملف Excel إلى: ' + result.path);
      } catch (error) { showToast('تعذر تصدير Excel: ' + error.message); }
      return;
    }
    if (!window.XLSX) {
      const rows = exportRecords.slice().reverse().map(excelRowForRecord);
      const blob = buildExcelWorkbookBlob(rows, 'سجل الوزن');
      downloadExcelBlob(blob, 'Weighbridge-120T-Records-' + dateKey(now()) + '.xlsx');
      showToast('تم تنزيل ملف Excel بنجاح');
      return;
    }
    const rows = exportRecords.slice().reverse().map(excelRowForRecord);
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = Object.keys(rows[0]).map(() => ({ wch: 23 }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'سجل الوزن');
    XLSX.writeFile(book, 'Weighbridge-120T-Records-' + dateKey(now()) + '.xlsx');
    showToast('تم تنزيل ملف Excel بنجاح');
  }

  function exportCSV() {
    const exportRecords = getReportExportRecords();
    if(!exportRecords.length){showToast('لا توجد عمليات لتصديرها');return;}
    const header=['رقم التذكرة','المستخدم','نوع الحركة','رقم السيارة','رقم المقطورة','اسم العميل','اسم السائق','اسم الشحنة','المحافظة','الوزنة الأولى كجم','الوزنة الثانية كجم','الوزن الصافي كجم','التاريخ'];
    const lines=[header,...exportRecords.map(r=>[r.id,r.createdByUserName || '',r.movementType || '—',r.plate,r.trailer || '—',r.customer,r.driver,r.shipment || '—',r.governorate || '—',r.firstWeight,r.secondWeight,r.netWeight,stamp(new Date(r.createdAt))])];
    const csv='\uFEFF'+lines.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='weighbridge-records.csv';a.click();URL.revokeObjectURL(url);
    showToast('تم تجهيز ملف CSV');
  }

  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.go)));
  $('mobileMenu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  ['firstWeightInput','secondWeightInput'].forEach(id => {
    $(id).addEventListener('input', () => {
      if (ticketSaved) return;
      $('formMessage').textContent = '';
      updateCaptureUI();
    });
  });
  $('weightMode').addEventListener('change',()=>{
    if ($('weightMode').value === 'manual') {
      activeWeightSource = 'manual';
      rawScaleWeight = null;
      $('formMessage').textContent = 'وضع الإدخال اليدوي مفعل. أدخل الوزنتين في الخانتين ثم اضغط حفظ.';
    } else {
      activeWeightSource = serialPort ? 'serial' : 'waiting';
      rawScaleWeight = null;
      $('formMessage').textContent = serialPort
        ? 'تم تفعيل القراءة التلقائية للميزان. أدخل الوزنتين ثم اضغط حفظ.'
        : 'وضع التلقائي مفعل؛ وصّل الميزان لعرض القراءة المباشرة. أدخل الوزنتين ثم اضغط حفظ.';
    }
    $('weightSourceLabel').textContent = activeWeightSource === 'serial'
      ? 'قراءة من الميزان'
      : activeWeightSource === 'manual' ? 'إدخال يدوي' : 'بانتظار القراءة';
  });
  $('captureWeight').addEventListener('click',capture);
  $('resetTicket').addEventListener('click',resetTicket);
  $('supervisorAddRecord').addEventListener('click', openSupervisorAddModal);
  $('supervisorFirstWeight').addEventListener('input', updateSupervisorNetPreview);
  $('supervisorSecondWeight').addEventListener('input', updateSupervisorNetPreview);
  $('supervisorAddForm').addEventListener('submit', event => {
    event.preventDefault();
    captureSupervisorRecord();
  });
  $('closeSupervisorAdd').addEventListener('click', closeSupervisorAddModal);
  $('cancelSupervisorAdd').addEventListener('click', closeSupervisorAddModal);
  $('supervisorAddModal').addEventListener('click', event => {
    if (event.target === $('supervisorAddModal')) closeSupervisorAddModal();
  });
  $('recordSearch').addEventListener('input',renderRecords);
  $('clearRecordSearch').addEventListener('click',()=>{ $('recordSearch').value=''; renderRecords(); });
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
    if (activeUser?.role === 'operator') {
      target.textContent = 'يتم حفظ سجلات حسابك تلقائيًا. ملف Excel الشامل متاح للمشرف.';
      target.classList.remove('is-error');
      target.title = '';
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
  $('explorerRefreshPorts').addEventListener('click', () => refreshDeviceExplorerPorts(true));
  $('explorerExportReport').addEventListener('click', exportDeviceExplorerReport);
  $('explorerCaptureStart').addEventListener('click', startDeviceExplorerCapture);
  $('explorerCaptureStop').addEventListener('click', stopDeviceExplorerCapture);
  $('explorerClearLog').addEventListener('click', () => {
    if (!deviceExplorerSamples.length) { showToast('سجل العينات فارغ بالفعل'); return; }
    deviceExplorerSamples = [];
    deviceExplorerLastProtocol = null;
    deviceExplorerRawBuffer = '';
    deviceExplorerSaveCounter = 0;
    saveDeviceExplorerState();
    renderDeviceExplorerSamples();
    showToast('تم مسح سجل عينات التشخيص');
  });
  $('explorerPortsTable').addEventListener('click', event => {
    const button = event.target.closest('[data-explorer-port]');
    if (!button) return;
    deviceExplorerSelectedPath = button.dataset.explorerPort;
    renderDeviceExplorerPorts();
  });
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
      const incoming = typeof data === 'string' ? data : String(data?.text ?? '');
      recordDeviceExplorerData(data);
      if (autoScanAttemptActive) consumeAutoScanData(incoming);
      else consumeDesktopSerialData(incoming);
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

    startSerialMonitoring = () => {
      autoDetectionEnabled = true;
      if (!serialMonitorTimer) {
        refreshPorts(true);
        serialMonitorTimer = setInterval(() => refreshPorts(false), 2000);
      }
    };
    stopSerialMonitoring = () => {
      autoDetectionEnabled = false;
      if (serialMonitorTimer) clearInterval(serialMonitorTimer);
      serialMonitorTimer = null;
    };
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
  $('printTicket').addEventListener('click',printTicketOnly);
  $('ticketModal').addEventListener('click',e=>{if(e.target===$('ticketModal'))$('ticketModal').classList.remove('open');});
  document.addEventListener('click',e=>{
    const editButton = e.target.closest('[data-edit-record]');
    if (editButton) { openSupervisorEditModal(editButton.dataset.editRecord); return; }
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
  renderDeviceExplorer();

  function setAuthPanel(name) {
    $('authLoginPanel').hidden = name !== 'login';
    $('authChangePanel').hidden = name !== 'change';
    $('authLoginMessage').textContent = '';
    $('authChangeMessage').textContent = '';
    if (name === 'login') setTimeout(() => $('authIdentifier').focus(), 0);
    if (name === 'change') setTimeout(() => $('authNewPassword').focus(), 0);
  }


  function openAccountSettings() {
    if (!activeUser) return;
    $('accountDisplayName').value = activeUser.displayName || '';
    $('accountNewPassword').value = '';
    $('accountNewPasswordConfirm').value = '';
    $('accountSettingsMessage').textContent = '';
    $('accountSettingsMessage').classList.remove('is-error');
    $('accountSettingsModal').classList.add('open');
    $('accountDisplayName').focus();
  }

  function closeAccountSettings() {
    $('accountSettingsModal').classList.remove('open');
  }

  $('accountSettingsButton').addEventListener('click', openAccountSettings);
  $('operatorAccountSettingsButton').addEventListener('click', openAccountSettings);
  $('closeAccountSettings').addEventListener('click', closeAccountSettings);
  $('cancelAccountSettings').addEventListener('click', closeAccountSettings);
  $('accountSettingsModal').addEventListener('click', event => {
    if (event.target === $('accountSettingsModal')) closeAccountSettings();
  });
  $('accountSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const displayName = $('accountDisplayName').value.trim();
    const password = $('accountNewPassword').value;
    const confirmation = $('accountNewPasswordConfirm').value;
    const message = $('accountSettingsMessage');
    message.classList.remove('is-error');
    if (displayName.length < 2) {
      message.textContent = 'اكتب اسمًا صحيحًا من حرفين على الأقل.';
      message.classList.add('is-error');
      $('accountDisplayName').focus();
      return;
    }
    if (password && password.length < 3) {
      message.textContent = 'كلمة المرور الجديدة يجب ألا تقل عن 3 أحرف.';
      message.classList.add('is-error');
      $('accountNewPassword').focus();
      return;
    }
    if (password !== confirmation) {
      message.textContent = 'تأكيد كلمة المرور غير مطابق.';
      message.classList.add('is-error');
      $('accountNewPasswordConfirm').focus();
      return;
    }
    const submit = $('saveAccountSettings');
    submit.disabled = true;
    message.textContent = 'جارٍ حفظ التغييرات...';
    try {
      const updatedUser = await window.desktopBridge.updateAccount({ displayName, password });
      activeUser = updatedUser;
      $('sessionUserName').textContent = (activeUser.role === 'supervisor' ? 'المشرف: ' : 'المستخدم: ') + activeUser.displayName;
      closeAccountSettings();
      showToast('تم تحديث بيانات الحساب فورًا');
    } catch (error) {
      message.textContent = error.message || 'تعذر تحديث بيانات الحساب.';
      message.classList.add('is-error');
    } finally {
      submit.disabled = false;
    }
  });

  function setAuthMessage(panel, message, isError = true) {
    const target = panel === 'change' ? $('authChangeMessage') : $('authLoginMessage');
    target.textContent = message;
    target.classList.toggle('is-error', isError);
  }

  async function populateSupervisorUsers() {
    if (activeUser?.role !== 'supervisor') return;
    try {
      const users = await window.desktopBridge.listUsers();
      const select = $('supervisorReportFilter');
      select.innerHTML = '<option value="all">كل المستخدمين</option>';
      users.forEach(user => {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.displayName + ' (' + user.username + ')';
        select.appendChild(option);
      });
      renderReports();
    } catch (error) {
      showToast('تعذر تحميل قائمة المستخدمين: ' + error.message);
    }
  }

  function openSupervisorUserModal() {
    if (activeUser?.role !== 'supervisor') return;
    $('supervisorUserForm').reset();
    const message = $('supervisorUserMessage');
    message.textContent = '';
    message.classList.remove('is-error');
    $('supervisorUserModal').classList.add('open');
    $('supervisorUserDisplayName').focus();
  }

  function closeSupervisorUserModal() {
    $('supervisorUserModal').classList.remove('open');
    $('supervisorUserForm').reset();
    $('supervisorUserMessage').textContent = '';
    $('supervisorUserMessage').classList.remove('is-error');
  }

  $('supervisorAddUser').addEventListener('click', openSupervisorUserModal);
  $('closeSupervisorUser').addEventListener('click', closeSupervisorUserModal);
  $('cancelSupervisorUser').addEventListener('click', closeSupervisorUserModal);
  $('supervisorUserModal').addEventListener('click', event => {
    if (event.target === $('supervisorUserModal')) closeSupervisorUserModal();
  });
  $('supervisorUserForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (activeUser?.role !== 'supervisor') return;

    const displayName = $('supervisorUserDisplayName').value.trim();
    const username = $('supervisorUserUsername').value.trim();
    const password = $('supervisorUserPassword').value;
    const confirmation = $('supervisorUserPasswordConfirm').value;
    const message = $('supervisorUserMessage');
    message.classList.remove('is-error');

    if (displayName.length < 2 || displayName.length > 80) {
      message.textContent = 'اكتب اسمًا ظاهرًا من حرفين إلى 80 حرفًا.';
      message.classList.add('is-error');
      $('supervisorUserDisplayName').focus();
      return;
    }
    if (username.length < 3 || username.length > 64) {
      message.textContent = 'اسم المستخدم يجب أن يكون من 3 إلى 64 حرفًا.';
      message.classList.add('is-error');
      $('supervisorUserUsername').focus();
      return;
    }
    if (password.length < 3 || password.length > 128) {
      message.textContent = 'كلمة المرور يجب أن تكون من 3 إلى 128 حرفًا.';
      message.classList.add('is-error');
      $('supervisorUserPassword').focus();
      return;
    }
    if (password !== confirmation) {
      message.textContent = 'تأكيد كلمة المرور غير مطابق.';
      message.classList.add('is-error');
      $('supervisorUserPasswordConfirm').focus();
      return;
    }

    const submit = $('saveSupervisorUser');
    submit.disabled = true;
    message.textContent = 'جارٍ إنشاء حساب المستخدم...';
    try {
      const createdUser = await window.desktopBridge.addUser({ displayName, username, password });
      closeSupervisorUserModal();
      await populateSupervisorUsers();
      showToast('تم إنشاء حساب ' + createdUser.displayName + ' بنجاح');
    } catch (error) {
      message.textContent = error.message || 'تعذر إنشاء حساب المستخدم.';
      message.classList.add('is-error');
    } finally {
      submit.disabled = false;
    }
  });

  function configureRoleUI() {
    const isSupervisor = activeUser?.role === 'supervisor';
    const isOperator = activeUser?.role === 'operator';
    document.documentElement.classList.toggle('operator-dashboard-only', isOperator);
    document.querySelectorAll('.nav-link').forEach(button => {
      button.hidden = isSupervisor && button.dataset.view !== 'reports';
    });
    document.querySelectorAll('.view').forEach(view => {
      view.hidden = isSupervisor && view.id !== 'view-reports';
    });
    $('supervisorReportControls').hidden = !isSupervisor;
    $('supervisorAddRecord').hidden = !isSupervisor;
    $('supervisorAddUser').hidden = !isSupervisor;
    $('accountSettingsButton').hidden = !isSupervisor;
    $('operatorAccountSettingsButton').hidden = !isOperator;
    $('reportUserHeader').hidden = !isSupervisor;
    $('openExcelFile').hidden = !isSupervisor;
    $('chooseExcelFile').hidden = !isSupervisor;
    $('clearData').hidden = isSupervisor;
    document.querySelectorAll('[data-delete-all-records]').forEach(button => { button.hidden = !isSupervisor; });
    $('sessionUserName').textContent = isSupervisor
      ? 'المشرف: ' + activeUser.displayName
      : 'المستخدم: ' + activeUser.displayName;
    $('sessionUserName').hidden = false;
    $('logoutButton').hidden = false;
    $('operatorLogoutButton').hidden = !isOperator;
    switchView(isSupervisor ? 'reports' : 'dashboard');
    if (isSupervisor) populateSupervisorUsers();
  }

  async function enterAuthenticatedApp(user) {
    activeUser = user;
    if (user.mustChangePassword) {
      $('authGate').hidden = false;
      setAuthPanel('change');
      return;
    }
    records = readJSON(STORAGE_KEY, []);
    $('authGate').hidden = true;
    document.documentElement.classList.remove('desktop-auth-required');
    configureRoleUI();
    renderAll();
    await refreshExcelSyncStatus();
    if (user.role === 'operator') startSerialMonitoring?.();
  }

  async function initializeAuthentication() {
    if (!desktop) {
      document.documentElement.classList.remove('desktop-auth-required');
      $('authGate').hidden = true;
      return;
    }
    $('authGate').hidden = false;
    try {
      await window.desktopBridge.getAuthStatus();
      setAuthPanel('login');
    } catch (error) {
      setAuthPanel('login');
      setAuthMessage('login', 'تعذر التحقق من إعداد الحسابات: ' + error.message);
    }
  }

  $('authLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('authLoginSubmit');
    submit.disabled = true;
    setAuthMessage('login', 'جارٍ التحقق من بيانات الدخول...', false);
    try {
      const user = await window.desktopBridge.login({
        identifier: $('authIdentifier').value.trim(),
        password: $('authPassword').value
      });
      $('authPassword').value = '';
      await enterAuthenticatedApp(user);
    } catch (error) {
      setAuthMessage('login', error.message || 'تعذر تسجيل الدخول.');
    } finally {
      submit.disabled = false;
    }
  });

  $('authChangeForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('authNewPassword').value;
    if (password.length < 3) {
      setAuthMessage('change', 'كلمة المرور الجديدة يجب ألا تقل عن 3 أحرف.');
      return;
    }
    if (password !== $('authNewPasswordConfirm').value) {
      setAuthMessage('change', 'تأكيد كلمة المرور غير مطابق.');
      return;
    }
    const submit = $('authChangeSubmit');
    submit.disabled = true;
    setAuthMessage('change', 'جارٍ تحديث كلمة المرور...', false);
    try {
      const user = await window.desktopBridge.changePassword({ password });
      $('authNewPassword').value = '';
      $('authNewPasswordConfirm').value = '';
      await enterAuthenticatedApp(user);
    } catch (error) {
      setAuthMessage('change', error.message || 'تعذر تحديث كلمة المرور.');
    } finally {
      submit.disabled = false;
    }
  });

  $('logoutButton').addEventListener('click', async () => {
    try { stopSerialMonitoring?.(); } catch {}
    try { await window.desktopBridge.logout(); } catch {}
    activeUser = null;
    records = [];
    activeRecord = null;
    ticketSaved = false;
    $('firstWeightInput').value = '';
    $('secondWeightInput').value = '';
    $('captureWeight').disabled = false;
    $('captureWeight').textContent = 'حفظ';
    rawScaleWeight = null;
    activeWeightSource = 'waiting';
    $('ticketModal').classList.remove('open');
    $('sessionUserName').hidden = true;
    $('logoutButton').hidden = true;
    $('operatorLogoutButton').hidden = true;
    $('accountSettingsButton').hidden = true;
    $('operatorAccountSettingsButton').hidden = true;
    $('supervisorAddRecord').hidden = true;
    $('supervisorAddUser').hidden = true;
    closeSupervisorUserModal();
    closeAccountSettings();
    closeSupervisorAddModal();
    document.documentElement.classList.remove('operator-dashboard-only');
    document.documentElement.classList.add('desktop-auth-required');
    $('authGate').hidden = false;
    $('authPassword').value = '';
    $('authNewPassword').value = '';
    $('authNewPasswordConfirm').value = '';
    setAuthPanel('login');
  });

  $('operatorLogoutButton').addEventListener('click', () => $('logoutButton').click());

  $('supervisorReportFilter').addEventListener('change', renderReports);
  initializeAuthentication();
  setWeight(liveWeight);setStability(true);updateCaptureUI();renderAll();
})();