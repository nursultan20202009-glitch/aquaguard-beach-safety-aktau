const $ = (selector) => document.querySelector(selector);
const state = { filter: 'all', activeView: 'video', selectedId: null, fingerprint: '', caseKey: '', videoReady: false, frameTimer: null, busy: false, events: [], zone: null, mapPoints: [] };
const mapState = { map: null, markers: new Map(), alertMarker: null, pointsKey: '', markerKey: '', viewKey: '' };

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function displayTime(value) {
  return new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Aqtau', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'}).format(new Date(value));
}

function tickClock() {
  $('#clock').textContent = new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Aqtau', hour:'2-digit', minute:'2-digit', second:'2-digit'}).format(new Date());
}
tickClock();
setInterval(tickClock, 1000);

function setSystemStatus(text, kind) {
  const status = $('#system-status');
  status.className = `system-status ${kind || ''}`;
  status.querySelector('span:last-child').textContent = text;
}

function activateView(view) {
  if (!['video', 'alerts', 'map'].includes(view)) return;
  state.activeView = view;
  $('.workspace-grid').dataset.activeView = view;
  document.querySelectorAll('[data-view-target]').forEach(button => {
    const active = button.dataset.viewTarget === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (view === 'map' && state.zone) {
    const selected = state.events.find(item => item.id === state.selectedId);
    requestAnimationFrame(() => {
      setMap(selected, state.zone);
      mapState.map?.invalidateSize();
    });
  }
}

function seaIcon(label, active) {
  return L.divIcon({
    className: 'sea-map-icon',
    html: `<span class="sea-marker${active ? ' active' : ''}">${escapeHTML(label)}</span>`,
    iconSize: [34, 34], iconAnchor: [17, 17],
  });
}

function ensureMap() {
  if (mapState.map) return true;
  if (typeof L === 'undefined') {
    $('#map-canvas').textContent = 'Не удалось загрузить модуль карты';
    return false;
  }
  mapState.map = L.map('map-canvas', {scrollWheelZoom: false}).setView([43.625, 51.173], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap contributors',
  }).addTo(mapState.map);
  return true;
}

function renderMapMarkers(event, zone) {
  if (state.activeView !== 'map') return;
  if (!ensureMap()) return;
  const points = state.mapPoints;
  const pointsKey = JSON.stringify(points);
  if (pointsKey !== mapState.pointsKey) {
    for (const marker of mapState.markers.values()) marker.remove();
    mapState.markers.clear();
    for (const point of points) {
      const marker = L.marker([point.latitude, point.longitude], {icon: seaIcon(point.id, false)}).addTo(mapState.map);
      marker.bindPopup(`<strong>Тестовая точка ${escapeHTML(point.id)}</strong><br>${escapeHTML(point.name)}<br>${Number(point.latitude).toFixed(7)}, ${Number(point.longitude).toFixed(7)}`);
      mapState.markers.set(point.id, marker);
    }
    mapState.pointsKey = pointsKey;
    mapState.markerKey = '';
  }

  const lat = Number(event?.latitude ?? zone.latitude);
  const lon = Number(event?.longitude ?? zone.longitude);
  const matchingPoint = points.find(point => Math.abs(point.latitude - lat) < 0.000001 && Math.abs(point.longitude - lon) < 0.000001);
  const markerKey = `${event?.id || ''}:${event?.status || ''}:${matchingPoint?.id || ''}:${pointsKey}`;
  if (markerKey !== mapState.markerKey) {
    for (const point of points) {
      const marker = mapState.markers.get(point.id);
      marker.setIcon(seaIcon(point.id, Boolean(event && point.id === matchingPoint?.id)));
      marker.setPopupContent(event && point.id === matchingPoint?.id
        ? `<strong>Тревога ${escapeHTML(event.id.slice(0, 8))}</strong><br>Тестовая точка ${escapeHTML(point.id)}<br>${lat.toFixed(7)}, ${lon.toFixed(7)}`
        : `<strong>Тестовая точка ${escapeHTML(point.id)}</strong><br>${escapeHTML(point.name)}<br>${Number(point.latitude).toFixed(7)}, ${Number(point.longitude).toFixed(7)}`);
    }
    if (mapState.alertMarker) { mapState.alertMarker.remove(); mapState.alertMarker = null; }
    if (!matchingPoint && (event || !points.length)) {
      mapState.alertMarker = L.marker([lat, lon], {icon: seaIcon(event ? '!' : 'A', Boolean(event))}).addTo(mapState.map);
      mapState.alertMarker.bindPopup(event
        ? `<strong>Выбранная тревога ${escapeHTML(event.id.slice(0, 8))}</strong><br>${lat.toFixed(7)}, ${lon.toFixed(7)}`
        : `<strong>Заданная зона</strong><br>${lat.toFixed(7)}, ${lon.toFixed(7)}`);
    }
    mapState.markerKey = markerKey;
  }
  const viewKey = `${pointsKey}:${event?.id || ''}`;
  if (viewKey !== mapState.viewKey) {
    const locations = points.map(point => [point.latitude, point.longitude]);
    if (event || !points.length) locations.push([lat, lon]);
    mapState.map.fitBounds(L.latLngBounds(locations).pad(0.4), {maxZoom: 15, animate: false});
    mapState.viewKey = viewKey;
  }
}

function setMap(event, zone) {
  const lat = Number(event?.latitude ?? zone.latitude);
  const lon = Number(event?.longitude ?? zone.longitude);
  const title = event?.beach ?? zone.beach;
  const name = event?.zone ?? zone.name;
  renderMapMarkers(event, zone);
  const kind = event?.coordinate_kind ?? zone.coordinate_kind;
  $('#location-label').textContent = event?.status === 'accepted' ? 'ПРИНЯТАЯ ТРЕВОГА · ТОЧКА ЗОНЫ' : event ? 'ВЫБРАННАЯ ТРЕВОГА · ТОЧКА ЗОНЫ' : 'ТЕСТОВАЯ ТОЧКА ЗОНЫ';
  $('#map-event-meta').textContent = event ? `Тревога ${event.id.slice(0, 8)} · ${displayTime(event.created_at)}` : 'Выберите тревогу для просмотра';
  $('#location-title').textContent = title;
  $('#location-zone').textContent = name;
  $('#lat').textContent = lat.toFixed(7);
  $('#lon').textContent = lon.toFixed(7);
  $('#coordinate-note').textContent = kind === 'test_zone'
    ? 'Тестовая геопозиция зоны. Положение человека в ролике неизвестно.'
    : 'Координаты заданной зоны. Положение человека по кадру не рассчитано.';
  $('#map-link').href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
}

function focusAcceptedEvent(event) {
  if (!event || !mapState.map) return;
  const lat = Number(event.latitude);
  const lon = Number(event.longitude);
  mapState.map.invalidateSize();
  const locations = state.mapPoints.map(point => [point.latitude, point.longitude]);
  locations.push([lat, lon]);
  mapState.map.fitBounds(L.latLngBounds(locations).pad(0.45), {maxZoom: 15, animate: false});
  const point = state.mapPoints.find(item => Math.abs(item.latitude - lat) < 0.000001 && Math.abs(item.longitude - lon) < 0.000001);
  const marker = point ? mapState.markers.get(point.id) : mapState.alertMarker;
  marker?.openPopup();
}

function statusLabel(status) {
  return {new:'Новая',accepted:'Принята',closed:'Закрыта'}[status] || status;
}

function renderCase(event) {
  const panel = $('#case-panel');
  panel.hidden = !event;
  if (!event) { state.caseKey = ''; return; }
  const key = JSON.stringify([event.id, event.status, event.accepted_at, event.closed_at, event.operator_note]);
  if (key === state.caseKey) return;
  state.caseKey = key;
  $('#case-id').textContent = `Тревога ${event.id.slice(0, 8)}`;
  $('#case-image').src = `/api/snapshots/${event.id}.jpg`;
  $('#case-status').className = `case-status ${event.status}`;
  $('#case-status').textContent = statusLabel(event.status);
  $('#case-coordinates').textContent = `${Number(event.latitude).toFixed(7)}, ${Number(event.longitude).toFixed(7)} · ${event.coordinate_kind === 'test_zone' ? 'тестовая точка' : 'заданная зона'}`;
  const timeline = [
    ['Обнаружено моделью', event.created_at, ''],
    ['Принято спасателем', event.accepted_at, event.status === 'new' ? 'Ожидает принятия' : 'Время не записано'],
    ['Событие закрыто', event.closed_at, event.status === 'closed' ? 'Время не записано' : 'Ожидает закрытия'],
  ];
  $('#case-timeline').innerHTML = timeline.map(([label, stamp, fallback]) =>
    `<li class="${stamp ? '' : 'pending'}"><span>${escapeHTML(label)}</span><time>${stamp ? displayTime(stamp) : escapeHTML(fallback)}</time></li>`
  ).join('');
  $('#operator-note').value = event.operator_note || '';
  $('#note-save-status').textContent = '';
  $('#report-link').href = `/report.html?id=${encodeURIComponent(event.id)}`;
}

function renderEvents(events, zone) {
  const open = events.filter(event => event.status !== 'closed').length;
  $('#open-count').textContent = `${open} активных`;
  $('#open-count').classList.toggle('has-open', open > 0);
  $('#nav-alert-count').textContent = String(open);
  $('#nav-alert-count').hidden = open === 0;
  if (!state.selectedId && events.length) state.selectedId = events[0].id;
  const selected = events.find(event => event.id === state.selectedId);
  setMap(selected, zone);
  renderCase(selected);

  const fingerprint = JSON.stringify([state.filter, state.selectedId, ...events.map(e => `${e.id}:${e.status}:${e.updated_at}`)]);
  if (fingerprint === state.fingerprint) return;
  state.fingerprint = fingerprint;
  const visible = events.filter(e => state.filter === 'all' || (state.filter === 'open' ? e.status !== 'closed' : e.status === 'closed'));
  if (!visible.length) {
    $('#event-list').innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><strong>${events.length ? 'Нет событий в этом разделе' : 'Ожидаем обнаружение'}</strong><p>${events.length ? 'Выберите другой фильтр событий.' : 'Первое событие появится, когда человек пробудет в красной зоне заданное время.'}</p></div>`;
    return;
  }
  $('#event-list').innerHTML = visible.map(event => {
    const active = event.id === state.selectedId ? ' selected' : '';
    const button = event.status === 'new'
      ? `<button class="action-button primary" data-id="${event.id}" data-status="accepted" type="button">Принять тревогу</button>`
      : event.status === 'accepted'
        ? `<button class="action-button" data-id="${event.id}" data-status="closed" type="button">Закрыть событие</button>`
        : `<span class="closed-label">✓ Завершено</span>`;
    return `<article class="event-card${active}" data-select="${event.id}" tabindex="0" aria-label="${escapeHTML(event.event_type)}">
      <div class="event-top"><span class="event-status ${event.status}"><span class="status-dot"></span>${statusLabel(event.status)}</span><time>${displayTime(event.created_at)}</time></div>
      <div class="event-main"><img src="/api/snapshots/${event.id}.jpg" alt="Кадр тревоги с рамкой обнаруженного человека" loading="lazy"><div><h3>${escapeHTML(event.event_type)}</h3><p>${escapeHTML(event.beach)}<br>${escapeHTML(event.zone)}</p></div></div>
      <div class="event-bottom"><span class="track-label">TRACK #${event.track_id} · ${Math.round(event.confidence * 100)}%</span><div class="event-actions"><a class="case-shortcut" target="_blank" rel="noopener noreferrer" href="/report.html?id=${encodeURIComponent(event.id)}">Отчёт ↗</a>${button}</div></div>
    </article>`;
  }).join('');
}

async function fetchState() {
  if (state.busy) return;
  state.busy = true;
  try {
    const response = await fetch('/api/state', {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.events = data.events;
    state.zone = data.zone;
    state.mapPoints = data.map_points || [];
    if (data.video.error) setSystemStatus(`Ошибка видео: ${data.video.error}`, 'error');
    else if (data.video.finished) setSystemStatus('Ролик завершён · нажмите «Повторить»', '');
    else setSystemStatus(data.video.ready ? 'Модель работает · сервер подключён' : 'Модель запускается…', data.video.ready ? 'online' : '');
    $('#source-badge').textContent = data.source_label;
    $('#source-selector').hidden = !data.is_test_source;
    $('#source-credit').hidden = !data.is_test_source;
    document.querySelectorAll('[data-source]').forEach(button => button.classList.toggle('active', button.dataset.source === data.video.mode));
    if (data.is_test_source && data.video.mode === 'coast') {
      $('#source-info-title').textContent = 'Тестовая съёмка пляжа с дрона';
      $('#source-info-text').textContent = 'Этот ролик снят не в Актау и не на Каспийском море. Пловцы здесь слишком малы для надёжного распознавания. Для показа автоматической тревоги выберите «Проверка тревоги · пловец в воде». Координаты зоны A на карте тестовые.';
      $('#source-credit').href = 'https://www.pexels.com/video/drone-view-of-people-swimming-in-the-sea-12943959/';
      $('#source-credit').textContent = 'Источник видео: Caden Knappier / Pexels ↗';
    } else if (data.is_test_source) {
      $('#source-info-title').textContent = 'Проверка тревоги: пловец в воде';
      $('#source-info-text').textContent = 'YOLO обнаруживает пловца в воде. Зелёная рамка становится красной при входе в тестовую зону A, затем сервер сохраняет тревогу. Съёмка не из Актау; координаты зоны на карте заданы вручную и не вычислены по кадру.';
      $('#source-credit').href = 'https://www.pexels.com/video/drone-shot-of-a-man-swimming-in-a-sea-12866527/';
      $('#source-credit').textContent = 'Источник видео: Ahmet Kurt / Pexels ↗';
    } else {
      $('#source-info-title').textContent = `Внешний источник: ${data.source_label}`;
      $('#source-info-text').textContent = `Источник видео задан оператором. Красный прямоугольник — зона A. ${data.zone.coordinate_kind === 'test_zone' ? 'Точка на карте условная и не получена из видео.' : 'Координаты зоны заданы отдельно; геопривязка людей по кадру не выполняется.'}`;
    }
    $('#map-tag').textContent = data.map_points?.length === 1 ? '1 ТЕСТОВАЯ ТОЧКА' : data.map_points?.length ? `${data.map_points.length} ТЕСТОВЫЕ ТОЧКИ` : data.zone.coordinate_kind === 'test_zone' ? 'ТЕСТОВАЯ ТОЧКА' : 'НАСТРОЕННАЯ ЗОНА';
    $('#restart-demo').hidden = !data.is_test_source || data.video.mode !== 'detection';
    $('#people-count').textContent = `Людей в кадре: ${data.video.ready ? data.video.people : '—'}`;
    $('#frame-counter').textContent = data.video.ready ? `КАДР ${data.video.frame_number}` : 'КАДР —';
    $('#dwell-label').textContent = String(data.zone.dwell_seconds).replace('.', ',');
    if (data.video.ready) {
      $('#video-placeholder').hidden = true;
      if (!state.videoReady) refreshFrame();
    }
    if (data.video.finished && state.frameTimer) {
      clearInterval(state.frameTimer);
      state.frameTimer = null;
    }
    if (data.video.ready && !data.video.finished && !state.frameTimer) {
      state.frameTimer = setInterval(refreshFrame, 500);
    }
    state.videoReady = data.video.ready;
    renderEvents(data.events, data.zone);
  } catch (error) {
    setSystemStatus('Сервер недоступен · повторная попытка…', 'error');
  } finally {
    state.busy = false;
  }
}

function refreshFrame() {
  $('#live-frame').src = `/api/frame.jpg?t=${Date.now()}`;
}

document.addEventListener('click', async (event) => {
  if (event.target.closest('a')) return;
  const viewButton = event.target.closest('[data-view-target]');
  if (viewButton) { activateView(viewButton.dataset.viewTarget); return; }
  const sourceButton = event.target.closest('[data-source]');
  if (sourceButton) {
    sourceButton.disabled = true;
    try {
      const response = await fetch('/api/demo/source', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({source: sourceButton.dataset.source})});
      if (!response.ok) throw new Error('Не удалось сменить видеоисточник');
      $('#video-placeholder').hidden = false;
      setSystemStatus('Переключаем видеоисточник…', '');
      await fetchState();
    } catch (error) { alert(error.message); }
    finally { sourceButton.disabled = false; }
    return;
  }
  const tab = event.target.closest('[data-filter]');
  if (tab) {
    state.filter = tab.dataset.filter;
    state.fingerprint = '';
    document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
    await fetchState();
    return;
  }
  const saveNote = event.target.closest('[data-save-note]');
  if (saveNote) {
    const selectedId = state.selectedId;
    const note = $('#operator-note').value.trim();
    saveNote.disabled = true;
    $('#note-save-status').textContent = 'Сохраняем…';
    try {
      const response = await fetch(`/api/events/${selectedId}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({note})});
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось сохранить заметку');
      const updated = await response.json();
      const current = state.events.find(item => item.id === selectedId);
      if (current) { current.operator_note = updated.operator_note; current.updated_at = updated.updated_at; }
      state.caseKey = '';
      renderCase(current);
      $('#note-save-status').textContent = 'Заметка сохранена';
      state.fingerprint = '';
      await fetchState();
    } catch (error) { $('#note-save-status').textContent = error.message; }
    finally { saveNote.disabled = false; }
    return;
  }
  const action = event.target.closest('[data-status]');
  if (action) {
    event.stopPropagation();
    action.disabled = true;
    const chosen = state.events.find(item => item.id === action.dataset.id);
    if (action.dataset.status === 'accepted' && chosen && state.zone) {
      state.selectedId = chosen.id;
      activateView('map');
      const map = $('#map-panel');
      map.scrollIntoView({behavior: 'auto', block: 'start'});
      map.focus({preventScroll: true});
    }
    try {
      const response = await fetch(`/api/events/${action.dataset.id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:action.dataset.status})});
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось изменить статус');
      state.selectedId = action.dataset.id;
      const selected = state.events.find(item => item.id === state.selectedId);
      if (selected && state.zone) setMap({...selected, status: action.dataset.status}, state.zone);
      state.fingerprint = '';
      await fetchState();
      if (action.dataset.status === 'accepted') requestAnimationFrame(() => focusAcceptedEvent(state.events.find(item => item.id === action.dataset.id)));
    } catch (error) {
      alert(error.message);
      action.disabled = false;
    }
    return;
  }
  const card = event.target.closest('[data-select]');
  if (card) {
    state.selectedId = card.dataset.select;
    state.fingerprint = '';
    await fetchState();
    activateView('map');
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-select]')) {
    event.preventDefault(); event.target.click();
  }
});

$('#restart-demo').addEventListener('click', async () => {
  const button = $('#restart-demo');
  button.disabled = true;
  try {
    const response = await fetch('/api/demo/restart', {method:'POST'});
    if (!response.ok) throw new Error('Не удалось перезапустить видео');
    setSystemStatus('Тестовый ролик запускается сначала…', '');
  } catch (error) { alert(error.message); }
  finally { setTimeout(() => { button.disabled = false; }, 1000); }
});

fetchState();
setInterval(fetchState, 1500);
