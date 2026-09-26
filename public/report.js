const $ = (selector) => document.querySelector(selector);
const formatTime = (value) => value ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Aqtau', day: '2-digit', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(value)) + ' · Актау' : 'Время не записано';

function timelineItem(label, value, pending) {
  const item = document.createElement('li');
  if (!value) item.className = 'pending';
  const title = document.createElement('strong');
  const time = document.createElement('span');
  title.textContent = label;
  time.textContent = value ? formatTime(value) : pending;
  item.append(title, time);
  return item;
}

async function loadReport() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Некорректный номер события');
  const response = await fetch(`/api/events/${id}`, {cache: 'no-store'});
  if (!response.ok) throw new Error('Событие не найдено на сервере');
  const event = await response.json();
  $('#report-number').textContent = event.id.slice(0, 8).toUpperCase();
  $('#event-type').textContent = event.event_type;
  $('#event-location').textContent = `${event.beach} · ${event.zone}`;
  $('#report-status').className = `status ${event.status}`;
  $('#report-status').textContent = {new:'Новая', accepted:'Принята', closed:'Закрыта'}[event.status] || event.status;
  $('#capture-time').textContent = formatTime(event.created_at);
  $('#report-snapshot').src = `/api/snapshots/${event.id}.jpg`;
  $('#zone-name').textContent = event.zone;
  $('#latitude').textContent = Number(event.latitude).toFixed(7);
  $('#longitude').textContent = Number(event.longitude).toFixed(7);
  $('#coordinate-warning').textContent = event.coordinate_kind === 'test_zone'
    ? 'Тестовая геопозиция зоны. Положение человека по кадру не определено.'
    : 'Координаты заданной зоны. Положение человека по кадру не определено.';
  $('#osm-link').href = `https://www.openstreetmap.org/?mlat=${event.latitude}&mlon=${event.longitude}#map=16/${event.latitude}/${event.longitude}`;
  $('#report-timeline').replaceChildren(
    timelineItem('Обнаружено моделью', event.created_at, ''),
    timelineItem('Принято спасателем', event.accepted_at, event.status === 'new' ? 'Ожидает принятия' : 'Время не записано'),
    timelineItem('Событие закрыто', event.closed_at, event.status === 'closed' ? 'Время не записано' : 'Ожидает закрытия'),
  );
  $('#source-label').textContent = `Источник: ${event.source_label}`;
  $('#track-meta').textContent = `ID трека ${event.track_id} · оценка детекции ${Math.round(event.confidence * 100)}%`;
  $('#operator-note').textContent = event.operator_note || 'Заметка не добавлена.';
  $('#report').hidden = false;
  $('#report-error').hidden = true;
  document.title = `Тревога ${event.id.slice(0, 8)} · AquaGuard Aktau`;
}

$('#print-report').addEventListener('click', () => window.print());
loadReport().catch(error => { $('#report-error').textContent = error.message; });
