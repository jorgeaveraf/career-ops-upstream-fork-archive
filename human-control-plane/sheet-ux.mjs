import { TAB_CONTRACTS } from './contracts.mjs';

export const README_TAB = 'README';
export const TODAY_HEADER_ROW_INDEX = 2;
export const TODAY_DATA_START_ROW_INDEX = 3;
export const WORKBOOK_TAB_ORDER = Object.freeze([
  README_TAB, 'TODAY', 'PIPELINE', 'APPLICATIONS', 'COMMUNITIES', 'CONTACTS',
  'FOLLOW_UPS', 'RESEARCH', 'SETTINGS', 'SOURCE_METRICS',
]);

const rgb = hex => {
  const value = hex.replace('#', '');
  return { red: parseInt(value.slice(0, 2), 16) / 255, green: parseInt(value.slice(2, 4), 16) / 255, blue: parseInt(value.slice(4, 6), 16) / 255 };
};
const fill = hex => ({ backgroundColorStyle: { rgbColor: rgb(hex) } });
const text = (hex, extra = {}) => ({ foregroundColorStyle: { rgbColor: rgb(hex) }, ...extra });
const grid = (sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({ sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });

export function buildTodayPresentationMatrix(matrix, summary = {}) {
  const [headers = [], ...sourceRows] = matrix || [];
  const attention = headers.indexOf('Attention Type');
  const humanDecision = headers.indexOf('Human Decision');
  const applicationDecision = headers.indexOf('Application Decision');
  const outreachDecision = headers.indexOf('Outreach Decision');
  const rows = sourceRows.map(source => {
    const row = [...source]; const type = String(row[attention] || '');
    if (type === 'DECISION_REQUIRED' && row[humanDecision] === 'NO_ACTION') row[humanDecision] = '';
    const allowed=String(row[headers.indexOf('Allowed Actions')]||'');
    if (['REVIEW_REQUIRED', 'APPROVAL_REQUIRED'].includes(type) && allowed.includes('APPROVE_TO_APPLY') && row[applicationDecision] === 'NO_ACTION') row[applicationDecision] = '';
    if (['OUTREACH_RECOMMENDED','OUTREACH_OPTIONAL'].includes(String(row[headers.indexOf('Outreach Recommendation')]||'')) && row[outreachDecision] === 'NO_ACTION') row[outreachDecision] = '';
    return row;
  });
  const width = Math.max(headers.length, 9); const top = Array(width).fill(''); const rule = Array(width).fill('');
  top[0] = 'CAREER OPS'; top[1] = 'Needs Your Attention'; top[2] = String(summary.needsAttention ?? 0);
  top[3] = 'Status'; top[4] = summary.status || 'UNKNOWN'; top[5] = 'Last Command'; top[6] = [summary.lastCommand, summary.commandStatus].filter(Boolean).join(' · ') || 'NONE';
  top[7] = 'Last Daily Completion'; top[8] = summary.lastDailyCompletion || 'NONE';
  rule[0] = 'RULE'; rule[1] = '0 = nothing to do'; rule[2] = '>0 = open HUMAN ATTENTION · edit yellow · Sync Jobs';
  return [top, rule, headers, ...rows];
}

export function stripTodayPresentationMatrix(matrix) {
  const header = (matrix || []).findIndex(row => row?.includes('Lane') && row?.includes('Entity ID'));
  if (header < 0) return matrix || [];
  return (matrix || []).slice(header);
}

export function buildTodayContextualValidationRequests(sheet, matrix) {
  const sheetId = sheet.properties.sheetId; const headers = matrix?.[0] || []; const rows = matrix?.slice(1) || [];
  const requests = [];
  const set = (rowIndex, field, allowed) => { const column = headers.indexOf(field); if (column < 0) return; requests.push({ setDataValidation: { range: grid(sheetId, TODAY_DATA_START_ROW_INDEX + rowIndex, TODAY_DATA_START_ROW_INDEX + rowIndex + 1, column, column + 1), rule: { condition: { type: 'ONE_OF_LIST', values: allowed.map(userEnteredValue => ({ userEnteredValue })) }, strict: true, showCustomUi: true } } }); };
  rows.forEach((row, index) => {
    const type = row[headers.indexOf('Attention Type')];
    if (type === 'DECISION_REQUIRED') { set(index, 'Human Decision', ['REJECT', 'HOLD', 'NEXT_STAGE']); set(index, 'Rejection Reason', ['ROLE_NOT_RELEVANT','COMPANY_NOT_INTERESTING','COMPENSATION','GEOGRAPHY','EMPLOYMENT_MODEL','SCHEDULE','SENIORITY','STACK_MISMATCH','LANGUAGE_REQUIREMENT','POOL_OR_MARKETPLACE','LOW_QUALITY_POSTING','OTHER']); }
    const allowed=String(row[headers.indexOf('Allowed Actions')]||'').split(' · ').filter(Boolean);
    if (['REVIEW_REQUIRED','APPROVAL_REQUIRED'].includes(type) && allowed.includes('APPROVE_TO_APPLY')) set(index, 'Application Decision', allowed);
    if (['OUTREACH_RECOMMENDED','OUTREACH_OPTIONAL'].includes(String(row[headers.indexOf('Outreach Recommendation')]||''))) set(index, 'Outreach Decision', ['APPROVE_OUTREACH','SKIP_OUTREACH','HOLD']);
    if (type==='REVIEW_REQUIRED' && !allowed.includes('APPROVE_TO_APPLY') && allowed.length) set(index, 'Human Decision', allowed);
    if (type === 'VERIFICATION_REQUIRED') set(index, 'Human Resolution', ['CONFIRMED_APPLIED','NOT_APPLIED','KEEP_UNKNOWN']);
    if (type === 'FOLLOW_UP_REQUIRED') set(index, 'Outcome', ['NO_OUTCOME','APPLIED','FOLLOW_UP','INTERVIEW','REJECTED_BY_COMPANY','OFFER','HIRED','WITHDRAWN','REJECTED','NO_RESPONSE','FAILED']);
  });
  return requests;
}

export function buildReadmeValues() {
  const rows = Array.from({ length: 122 }, () => Array(8).fill(''));
  const put = (row, column, value) => { rows[row - 1][column - 1] = value; };
  put(1, 1, 'Career Ops');
  put(2, 1, 'Guía del operador V4.5 · cierre de aplicaciones + hoja estable sin parpadeo');

  put(4, 1, 'ASÍ OPERAS CAREER OPS');
  put(5, 1, 'CAREER OPS TRABAJA SOLO. Tu única bandeja diaria es TODAY.');
  put(6, 1, 'Needs Your Attention = 0  →  no tienes nada que hacer.');
  put(7, 1, 'Needs Your Attention > 0  →  abre TODAY, atiende HUMAN ATTENTION, edita sólo amarillo y usa Career Ops → Sync Jobs. Después, Career Ops continúa solo y volverá a avisarte si necesita otra intervención.');
  put(8, 1, 'PREFERRED PURSUIT');
  put(9, 1, 'Aplicar por la ruta oficial del trabajo  +  contactar al mejor contacto verificado cuando corresponda y tú lo apruebes. La aplicación es primaria; el outreach es secundario y complementario.');

  put(11, 1, 'CÓMO PERSIGUE UNA OPORTUNIDAD');
  const pursuit = [
    ['DISCOVERED', 'Career Ops encontró una oportunidad fuerte.'],
    ['PREPARING', 'Investiga, evalúa, genera artefactos, resuelve la ruta oficial y encuentra el mejor contacto.'],
    ['READY', 'Tú revisas paquete + plan de aplicación + plan de outreach exactos.'],
    ['APPROVALS', 'Eliges APPROVE_TO_APPLY y, cuando aplique, APPROVE_OUTREACH. Son autorizaciones separadas.'],
    ['SYNC JOBS', 'Career Ops valida y registra tus decisiones exactas.'],
    ['APPLICATION', 'Aplica por el destino oficial/canónico; si aparece un límite humano, conserva la sesión y delega sólo la microacción.'],
    ['OUTREACH', 'Tras CONFIRMED_APPLIED, ejecuta el outreach aprobado al mejor contacto según su timing.'],
    ['APPLICATIONS', 'El trabajo sale de TODAY; outreach pendiente, respuestas, follow-up y outcomes continúan aquí.'],
  ];
  pursuit.forEach(([stage,description],index)=>{put(12+index,1,stage);put(12+index,3,description);});
  put(20, 1, 'Ruta primaria: ATS, plataforma, careers page o email oficial sólo si el posting indica explícitamente aplicar por email. Un recruiter no sustituye la aplicación oficial.');

  put(22, 1, 'QUÉ SIGNIFICA READY');
  put(23, 1, 'READY = “puedo revisar ahora el plan exacto de persecución”. No es una promesa optimista ni sólo un CV listo.');
  put(24, 1, 'Career Ops ya resolvió: evaluación · paquete actual · ruta de aplicación · preguntas/artefactos requeridos · Contact Intelligence · mejor contacto.');
  put(25, 1, 'También resolvió: recomendación, canal y timing de outreach · activation/outreach_plan versionado y ligado a aprobación. TODAY enlaza Resume/Cover Letter del paquete exacto; Cover Letter puede ser NOT_NEEDED y Resume requerido + NOT_GENERATED nunca es READY.');

  put(27, 1, 'TU RUTINA DIARIA');
  const routine = [
    ['1 · RECIBE AVISO', 'Career Ops te avisa sólo cuando hay resultado o intervención útil.'],
    ['2 · ABRE TODAY', 'Es tu única bandeja diaria. Rank 1 es la mejor acción u oportunidad actual.'],
    ['3 · TRABAJA POR RANK', 'Avanza de Rank 1 hacia abajo; no uses PIPELINE como inbox alterno.'],
    ['4 · REVISA', 'Revisa paquete, ruta oficial, mejor contacto, mensaje y timing.'],
    ['5 · EDITA AMARILLO', 'Completa únicamente las decisiones o respuestas humanas activas.'],
    ['6 · SYNC JOBS', 'Career Ops valida e importa tus cambios de forma idempotente.'],
    ['7 · CONTINÚA SOLO', 'Aplicación, timing aprobado, outreach, tracking y movimiento siguen automáticamente.'],
  ];
  routine.forEach(([step,description],index)=>{put(28+index,1,step);put(28+index,3,description);});

  put(36, 1, 'DOS AUTORIZACIONES EXACTAS E INDEPENDIENTES');
  put(37, 1, 'APPROVE_TO_APPLY'); put(37, 3, 'APPROVE_TO_APPLY autoriza exactamente una aplicación para el trabajo, paquete y ruta actuales. No autoriza mensajes.');
  put(38, 1, 'APPROVE_OUTREACH'); put(38, 3, 'Autoriza exactamente una acción de outreach para el contacto, canal, mensaje y timing actuales. No autoriza aplicar.');
  put(39, 1, 'STALE APPROVAL'); put(39, 3, 'Si cambian materialmente trabajo, paquete, ruta, contacto, canal, mensaje o timing, la aprobación anterior deja de ser válida.');

  put(41, 1, 'APLICACIÓN + OUTREACH · RESULTADO DE TUS DECISIONES');
  put(42, 1, 'APLICACIÓN'); put(42, 3, 'OUTREACH'); put(42, 5, 'RESULTADO');
  const matrix = [
    ['NO','NO','No ocurre ninguna acción externa.'],
    ['SÍ','NO','Career Ops aplica por la ruta oficial; no contacta a nadie.'],
    ['NO','SÍ','No puede afirmar “apliqué”. Sólo ejecuta si el plan permite outreach independiente; el caso normal after-application espera.'],
    ['SÍ','SÍ','Aplica primero, confirma APPLIED y ejecuta outreach según timing.'],
  ];
  matrix.forEach((item,index)=>{put(43+index,1,item[0]);put(43+index,3,item[1]);put(43+index,5,item[2]);});

  put(48, 1, 'CANALES DE OUTREACH');
  put(49, 1, 'CANAL'); put(49, 3, 'CAREER OPS HACE'); put(49, 6, 'TÚ HACES');
  put(50, 1, 'GMAIL'); put(50, 3, 'Tras APPROVE_OUTREACH, envía autónomamente con Gmail API desde jorgeaveraf@gmail.com; persiste message/thread, evita duplicados y detecta replies.'); put(50, 6, 'Nada, salvo ambigüedad o respuesta. Nunca usa career@brunova.mx ni fubifo@gmail.com para candidate outreach.');
  put(51, 1, 'LINKEDIN'); put(51, 3, 'Con el perfil Chrome Jorge, verifica perfil exacto, espera validaciones pasivas y usa el mismo resolver de preguntas que Indeed/ATS.'); put(51, 6, 'Sólo resuelves login, MFA, CAPTCHA interactivo, challenge/restriction o una respuesta irreducible. No hay bypass ni blind retry.');
  put(52, 1, 'OTRAS RUTAS'); put(52, 3, 'X/Twitter, Slack, Discord, The Org, Wellfound no soportado, contact form u otra ruta útil → MANUAL_OUTREACH_RECOMMENDED con contacto, URL, mensaje, razón y timing.'); put(52, 6, 'Tú ejecutas manualmente el mensaje exacto; Career Ops no opera ese canal.');

  put(54, 1, 'UN SOLO MEJOR CONTACTO');
  put(55, 1, 'Career Ops elige un contacto relevante y verificado: recruiter, hiring manager, team lead, Talent Acquisition, founder/leader o ruta oficial de recruiting.');
  put(56, 1, 'No mass outreach · no blasts a cinco personas · no guessed emails · una acción primaria por trabajo aprobado. Contactos secundarios quedan como evidencia/fallback, no como envíos automáticos.');

  put(58, 1, 'QUÉ PASA DESPUÉS DE SYNC JOBS');
  put(59, 1, 'Aplicación aprobada'); put(59, 3, 'APPROVE_TO_APPLY significa que Career Ops aplica: prefiere adapter nativo y usa Generic Browser como fallback; registra APPLIED sólo con confirmación observable.');
  put(60, 1, 'Outreach after-application'); put(60, 3, 'Espera CONFIRMED_APPLIED; una aplicación UNKNOWN o FAILED no dispara un mensaje que diga “apliqué”.');
  put(61, 1, 'Outreach next business day'); put(61, 3, 'Se agenda automáticamente con America/Mexico_City. No necesitas recordar ni ejecutar otro Sync Jobs.');
  put(62, 1, 'APPLIED'); put(62, 3, 'Al observar confirmación, el trabajo sale automáticamente de TODAY y entra una sola vez a APPLICATIONS. No requiere Sync Jobs; el outreach aprobado sigue vigente.');
  put(63, 1, 'Ambigüedad'); put(63, 3, 'VERIFICATION_REQUIRED. Nunca hay retry ciego ni cambio automático a otro contacto.');
  put(64, 1, 'Un batch genera un solo digest consolidado. La reconciliación de confirmación es silenciosa y automática. La Sheet sólo cambia cuando cambia el estado de Career Ops; los procesos en segundo plano no la redibujan.');

  put(65, 1, 'RESPUESTAS Y FOLLOW-UP');
  put(66, 1, 'Gmail'); put(66, 3, 'Career Ops correlaciona el thread y detecta respuestas del destinatario; una respuesta devuelve la oportunidad a HUMAN ATTENTION.');
  put(67, 1, 'LinkedIn'); put(67, 3, 'El chequeo de respuesta es acotado y sólo cuando es técnicamente seguro; no hay polling agresivo.');
  put(68, 1, 'Conversación'); put(68, 3, 'V4.4.1 responde automáticamente con Candidate KB, derivación, política o evidencia; sólo tú decides hechos personales desconocidos y attestations.');
  put(69, 1, 'Follow-up'); put(69, 3, 'Puede recomendar/agendar fecha, pero el primer APPROVE_OUTREACH no autoriza una secuencia; un nuevo mensaje normalmente requiere otra aprobación exacta.');

  put(71, 1, 'CUÁNDO DEBES SALIR DE LA HOJA');
  put(72, 1, 'OPERACIÓN NORMAL'); put(72, 3, 'Quédate en la Sheet: NO repo · NO CLI · NO logs · NO ChatGPT.');
  put(73, 1, 'EXTERNAL_ACTION_REQUIRED'); put(73, 3, 'Aparece sólo ante interacción confirmada. Abre Open Application, realiza únicamente CAPTCHA, MFA, login o challenge indicado y deja la pestaña abierta.');
  put(74, 1, 'MANUAL_OUTREACH_RECOMMENDED'); put(74, 3, 'Sal para usar una ruta no automatizada; Career Ops te entrega URL pública + mensaje + razón + timing.');

  put(76, 1, 'HUMAN ATTENTION · QUÉ SIGNIFICA CADA ATTENTION TYPE');
  put(77, 1, 'ATTENTION TYPE'); put(77, 3, 'QUÉ SIGNIFICA'); put(77, 5, 'QUÉ HACES TÚ'); put(77, 7, 'QUÉ PASA DESPUÉS');
  const attention = [
    ['DECISION_REQUIRED', 'Debes decidir si la oportunidad avanza.', 'Elige NO_ACTION, REJECT, HOLD o NEXT_STAGE.', 'NEXT_STAGE inicia preparación; HOLD pausa; REJECT la retira conservando tu razón.'],
    ['REVIEW_REQUIRED', 'El plan exacto está listo para revisar.', 'Revisa paquete + estrategia; decide aplicación y outreach por separado cuando estén disponibles.', 'Las aprobaciones exactas habilitan sólo las acciones elegidas.'],
    ['ANSWER_REQUIRED', 'Career Ops agrupó todos los datos humanos pendientes.', 'Lee Question Bundle, responde todo una vez en Human Answer y usa Sync Jobs.', 'Valida el bloque completo, reutiliza sólo hechos permitidos y continúa la misma ejecución.'],
    ['APPROVAL_REQUIRED', 'Falta una autorización exacta.', 'Elige la acción permitida, como APPROVE_TO_APPLY o APPROVE_OUTREACH.', 'Ejecuta una sola acción ligada al plan actual.'],
    ['VERIFICATION_REQUIRED', 'Submit o delivery pudo ocurrir, pero no hay confirmación suficiente.', 'Para aplicación: CONFIRMED_APPLIED, NOT_APPLIED o KEEP_UNKNOWN. RETRY no existe.', 'Registra verificación sin repetir la acción ambigua.'],
    ['FOLLOW_UP_REQUIRED', 'Hay respuesta, follow-up o outcome que necesita juicio humano.', 'Revisa respuesta; edita Follow-Up Date, Follow-Up Action, Notes u Outcome.', 'APPLICATIONS y FOLLOW_UPS conservan el contexto.'],
    ['EXTERNAL_ACTION_REQUIRED', 'Una plataforma exige login, MFA, CAPTCHA, challenge o confirmación.', 'Usa Open Application y completa sólo la acción indicada.', 'Career Ops conserva la sesión, detecta la resolución y reanuda automáticamente.'],
  ];
  attention.forEach((item, index) => item.forEach((value, column) => put(78 + index, 1 + column * 2, value)));
  put(85, 1, 'QUEUED = aceptado, no hagas nada · WORKING = Career Ops ejecutando · WAITING_FOR_YOU = acción humana real · ANSWER_REQUIRED siempre muestra una pregunta concreta, nunca un código técnico.');

  put(86, 1, 'SOLO EDITA AMARILLO');
  put(87, 1, 'Human Decision · Rejection Reason · Application Decision · Outreach Decision · Human Answer · Human Resolution · Resolution Notes · Follow-Up Date · Follow-Up Action · Notes · Outcome · Membership Decision');
  put(88, 1, 'Amarillo = acción requerida ahora; gris = contexto/historial. Todo lo demás es administrado por Career Ops. Nunca escribas contraseñas, códigos MFA, tokens ni credenciales.');

  put(90, 1, 'CAREER OPS HACE ESTO POR TI'); put(90, 5, 'CAREER OPS NUNCA HACE ESTO AUTOMÁTICAMENTE');
  put(91, 1, 'Descubre y rankea · evalúa · genera paquete · resuelve ruta oficial · investiga un mejor contacto · aplica tras APPROVE_TO_APPLY · envía Gmail/LinkedIn tras APPROVE_OUTREACH · agenda timing · rastrea Gmail replies · conserva outreach tras APPLIED · recomienda rutas manuales.');
  put(91, 5, 'Aplicar sin APPROVE_TO_APPLY · outreach sin APPROVE_OUTREACH · mass outreach · guessed emails · ejecutar canales no soportados · bypass CAPTCHA/MFA · retry de submit/send ambiguo · auto-reply · follow-up no aprobado · candidate outreach desde career@brunova.mx o fubifo@gmail.com.');

  put(93, 1, 'SEGURIDAD DE VERIFICACIÓN');
  put(94, 1, 'CONFIRMED_APPLIED = aplicación confirmada · NOT_APPLIED = confirmaste que no ocurrió · KEEP_UNKNOWN = aún no hay evidencia. RETRY no existe.');

  put(96, 1, 'MAPA DEL CICLO');
  put(97, 1, 'ETAPA'); put(97, 3, 'QUÉ HACE CAREER OPS'); put(97, 7, 'QUÉ HACES TÚ');
  const lifecycle = [
    ['DISCOVERED', 'Encontró una oportunidad fuerte.', 'REJECT, HOLD o NEXT_STAGE.'],
    ['PREPARING', 'Investiga, evalúa, genera artefactos, encuentra contacto y arma ambos planes.', 'Normalmente espera; responde sólo si lo pide.'],
    ['READY', 'El plan exacto de persecución está completo.', 'Revisa y decide aplicación/outreach por separado.'],
    ['APPLIED', 'La aplicación quedó confirmada; outreach aprobado puede continuar.', 'El trabajo ya está en APPLICATIONS.'],
    ['ON HOLD', 'Pausa ortogonal sin destruir el estado técnico.', 'Retoma cuando quieras.'],
  ];
  lifecycle.forEach((item, index) => { put(98 + index, 1, item[0]); put(98 + index, 3, item[1]); put(98 + index, 7, item[2]); });
  put(103, 1, 'NEXT_STAGE inicia preparación; no autoriza aplicación ni outreach. NEXT_STAGE prepara; no autoriza un envío. La preparación queda Queued for enrichment.');

  put(105, 1, 'GUÍA DE PESTAÑAS');
  put(106, 1, 'PESTAÑA'); put(106, 2, 'PARA QUÉ SIRVE'); put(106, 5, 'PESTAÑA'); put(106, 6, 'PARA QUÉ SIRVE');
  const tabPairs = [
    [['README','Esta guía.'],['TODAY','Única bandeja diaria: cola curada, Rank y aprobaciones.']],
    [['PIPELINE','Inventario activo amplio; no es inbox.'],['RESEARCH','Evidencia pendiente del sistema.']],
    [['APPLICATIONS','Aplicaciones confirmadas + outreach status + follow-up + outcomes.'],['CONTACTS','Contact Intelligence verificada + provenance + outreach status.']],
    [['FOLLOW_UPS','Follow-up recomendado/agendado y trabajo humano.'],['COMMUNITIES','WANT_TO_JOIN autoriza un join exacto; JOINED confirma membresía. Sync Communities nunca responde preguntas: SKIP/REJECT suprime sin borrar historial.']],
    [['SETTINGS','Incluye Candidate Gmail / LinkedIn Outreach readiness.'],['SOURCE_METRICS','Telemetría; no es de uso diario.']],
  ];
  tabPairs.forEach((pair,index)=>{put(107+index,1,pair[0][0]);put(107+index,2,pair[0][1]);put(107+index,5,pair[1][0]);put(107+index,6,pair[1][1]);});

  put(113, 1, 'HORARIO Y TIEMPO HUMANO · America/Mexico_City');
  put(114, 1, '15:30 Browser Research · 16:00 Core · 17:00 Application Enrichment · ejemplo visible: Hoy · 5:00 PM o 29 ago 2026 · 5:00 PM. Nunca UTC crudo para el operador.');

  put(116, 1, 'NOTIFICACIONES SIN RUIDO');
  put(117, 1, 'Sync Jobs exitoso = confirmación en Sheet, NO EMAIL. Career Ops notifica resultados o blockers accionables y envía un resumen diario compacto; no notifica drafts, schedules, composer abierto, ranking interno ni autorrecuperación exitosa.');

  put(119, 1, 'REGLA SIMPLE');
  put(120, 1, 'Needs Your Attention = 0  →  no hagas nada.');
  put(121, 1, 'Needs Your Attention > 0  →  abre TODAY, trabaja desde Rank 1, edita amarillo y usa Sync Jobs.');
  put(122, 1, 'Career Ops hará el resto: completar la aplicación oficial, confirmar, mover a APPLICATIONS, continuar outreach aprobado y escalar sólo el siguiente límite humano real.');
  return rows;
}

export function buildTabOrderRequests(sheets) {
  const byName = new Map((sheets || []).map(sheet => [sheet.properties.title, sheet.properties]));
  return WORKBOOK_TAB_ORDER.flatMap((title, index) => {
    const sheet = byName.get(title);
    return sheet ? [{ updateSheetProperties: { properties: { sheetId: sheet.sheetId, index }, fields: 'index' } }] : [];
  });
}

function columnWidths(name, columns) {
  const exact = {
    TODAY: { Lane:130, Company:150, Role:240, Stage:110, Status:145, Action:180, 'Handoff Type':175, 'Handoff Instruction':300, 'Open Application':150, 'Question Bundle':320, 'Application Progress':180, Recommendation:145, Rank:70, Location:145, 'Workflow Stage':105, 'Workflow Status':145, 'Last Activity':250, 'Last Updated':135, 'Attention Type':185, 'Attention Priority':105, Reason:260, Question:230, 'Allowed Actions':245, 'Recommended Action':260, 'Human Decision':145, 'Rejection Reason':170, 'Application Decision':155, 'Human Answer':260, 'Human Resolution':185, 'Resolution Notes':230, 'Follow-Up Date':125, 'Follow-Up Action':210, Notes:210, Outcome:145, Evaluation:170, 'Key Fit Reasons':260, 'Meaningful Gaps':250, 'Application Path':145, 'Package Version':105, Resume:245, 'Cover Letter':270, Contacts:170, 'Job URL':130, Movement:72, Eligibility:100, 'Final Priority':92, 'Evidence Confidence':112, 'Missing Evidence':200, 'Why This Role':250, 'Last Command':125, 'Command Status':125, 'Command Result':230, 'Attention Status':145, 'Enrichment Summary':280, 'Last Enriched':145, 'Human Blocker':200, 'Lifecycle State':145, 'Decision Outcome':145, 'Enrichment Status':140, 'Execution Status':145 },
    PIPELINE: { State: 95, 'Current Rank': 88, Company: 150, Role: 230, Eligibility: 100, 'Selection Score': 100, 'Final Priority': 92, 'Attention Status': 145, 'Evidence Confidence': 112, 'Research Needs': 250, Freshness: 76, Source: 125, 'Human Decision': 150, 'Rejection Reason': 170, 'Decision Outcome': 145, 'Enrichment Status': 135, 'Last Updated': 155, 'Job URL': 130 },
    RESEARCH: { 'Research Priority': 112, Company: 150, Role: 230, 'Current Rank': 88, Eligibility: 100, 'Potential Value': 100, Needs: 270, 'Primary Blocker': 180, Status: 90, 'Last Research': 145, 'Job URL': 130, 'Human Notes': 240 },
    COMMUNITIES: { Recommendation:125, Community:220, 'Workflow Stage':110, 'Workflow Status':165, 'Last Activity':280, 'Last Updated':135, Topic:140, Visibility:90, Members:95, Activity:90, 'Opportunity Signal':120, Spam:80, Quality:80, 'Membership State':145, 'Monitoring Readiness':165, 'Monitoring Status':150, 'Posts Seen':95, 'Opportunities Found':130, 'Why It Matters':300, 'Group URL':150, 'Membership Decision':155, Notes:240, 'Last Checked':145 },
    APPLICATIONS: { Company: 150, Role: 230, 'Applied Date': 145, 'Application Channel': 130, Confirmation: 220, 'Application Status': 145, 'Interview Date': 130, 'Next Action': 220, Outcome: 130, Contacts: 120, 'Job URL': 130, Notes: 240 },
    CONTACTS: { Job: 290, Company: 155, 'Contact Status': 165, 'Contact Summary': 360, 'Contact Count': 105, 'Best Contact': 180, Relationship: 185, Channels: 190, 'Evidence Confidence': 145, 'Last Researched': 170, 'Outreach Status': 160, Notes: 220, 'Job URL': 130 },
    FOLLOW_UPS: { Date: 120, Action: 230, 'Related Job': 150, Status: 120, Notes: 250 },
    SETTINGS: { Key: 180, Value: 260, Owner: 125, Description: 300 },
    SOURCE_METRICS: {},
  }[name] || {};
  return columns.map(column => exact[column] || (column.includes('URL') ? 130 : 115));
}

function booleanRule(ranges, type, value, background, { bold = false, foreground = '#243447', ...textOptions } = {}) {
  return { ranges, booleanRule: { condition: { type, values: [{ userEnteredValue: value }] }, format: { ...fill(background), textFormat: text(foreground, { bold, ...textOptions }) } } };
}

function customRule(ranges, formula, background, { bold = false, foreground = '#243447' } = {}) {
  return booleanRule(ranges, 'CUSTOM_FORMULA', formula, background, { bold, foreground });
}

function addRule(requests, rule, index) { requests.push({ addConditionalFormatRule: { rule, index } }); }
function sheetColumn(index) { let value=index+1,result='';while(value){value--;result=String.fromCharCode(65+value%26)+result;value=Math.floor(value/26);}return result; }

export function buildManagedTabFormatRequests(sheet) {
  const name = sheet.properties.title;
  const contract = TAB_CONTRACTS[name];
  if (!contract) return [];
  const sheetId = sheet.properties.sheetId;
  const rowCount = sheet.properties.gridProperties?.rowCount || 1000;
  const width = contract.columns.length;
  const endRow = Math.min(rowCount, 1001);
  const today = name === 'TODAY';
  const headerRow = today ? TODAY_HEADER_ROW_INDEX : 0;
  const dataStart = headerRow + 1;
  const formulaRow = dataStart + 1;
  const requests = [];

  for (let index = (sheet.conditionalFormats || []).length - 1; index >= 0; index--) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
  requests.push(
    { repeatCell: { range: grid(sheetId, headerRow, headerRow + 1, 0, width), cell: { userEnteredFormat: { ...fill('#27364B'), textFormat: text('#FFFFFF', { bold: true }), verticalAlignment: 'MIDDLE', horizontalAlignment: 'LEFT', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat,verticalAlignment,horizontalAlignment,wrapStrategy)' } },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: headerRow + 1, frozenColumnCount: today ? 3 : 0, hideGridlines: false } }, fields: 'gridProperties(frozenRowCount,frozenColumnCount,hideGridlines)' } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: headerRow, startColumnIndex: 0, endColumnIndex: width } } } },
    { repeatCell: { range: grid(sheetId, dataStart, endRow, 0, width), cell: { userEnteredFormat: { ...fill('#FFFFFF'), verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP', textFormat: text('#243447') } }, fields: 'userEnteredFormat' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: headerRow, endIndex: headerRow + 1 }, properties: { pixelSize: 46 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: dataStart, endIndex: Math.min(endRow, dataStart + 100) }, properties: { pixelSize: today ? 62 : name === 'PIPELINE' ? 60 : name === 'RESEARCH' ? 52 : 44 }, fields: 'pixelSize' } },
    { setDataValidation: { range: grid(sheetId, dataStart, endRow, 0, width) } },
  );
  if (today) requests.push(
    { repeatCell: { range:grid(sheetId,0,headerRow,0,width),cell:{note:null},fields:'note' } },
    { repeatCell: { range: grid(sheetId,0,1,0,width), cell:{userEnteredFormat:{...fill('#17324D'),textFormat:text('#FFFFFF',{bold:true,fontSize:11}),verticalAlignment:'MIDDLE',wrapStrategy:'WRAP'}}, fields:'userEnteredFormat' } },
    { repeatCell: { range: grid(sheetId,1,2,0,width), cell:{userEnteredFormat:{...fill('#EAF4EA'),textFormat:text('#175C2C',{bold:true}),verticalAlignment:'MIDDLE',wrapStrategy:'WRAP'}}, fields:'userEnteredFormat' } },
    { updateDimensionProperties: { range:{sheetId,dimension:'ROWS',startIndex:0,endIndex:1},properties:{pixelSize:44},fields:'pixelSize' } },
    { updateDimensionProperties: { range:{sheetId,dimension:'ROWS',startIndex:1,endIndex:2},properties:{pixelSize:40},fields:'pixelSize' } },
  );

  const widths = columnWidths(name, contract.columns);
  widths.forEach((pixelSize, column) => requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 }, properties: { pixelSize }, fields: 'pixelSize' } }));

  const wrapFields = new Set(['Role','Reason','Question','Question Bundle','Handoff Instruction','Allowed Actions','Recommended Action','Key Fit Reasons','Meaningful Gaps','Resolution Notes','Follow-Up Action','Last Activity', 'Command Result', 'Why This Role', 'Missing Evidence', 'Research Needs', 'Needs', 'Primary Blocker', 'Notes', 'Human Notes', 'Next Action', 'Enrichment Summary', 'Human Blocker', 'Human Answer', 'Contact Summary']);
  for (const field of wrapFields) {
    const column = contract.columns.indexOf(field);
    if (column >= 0) requests.push({ repeatCell: { range: grid(sheetId, dataStart, endRow, column, column + 1), cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } });
  }

  for (let column = 0; column < width; column++) {
    const field = contract.columns[column];
    const humanOwned = contract.humanOwned.includes(field);
    requests.push({ updateCells: { range: grid(sheetId, headerRow, headerRow + 1, column, column + 1), rows: [{ values: [{ note: humanOwned ? (today ? 'Contextual human input — yellow means actionable now.' : 'Human input — safe to edit.') : 'Managed by Career Ops — do not edit.' }] }], fields: 'note' } });
  }

  for (const field of contract.humanOwned) {
    const column = contract.columns.indexOf(field);
    requests.push(
      { repeatCell: { range: grid(sheetId, headerRow, headerRow + 1, column, column + 1), cell: { userEnteredFormat: { ...fill('#8A6D1D'), textFormat: text('#FFFFFF', { bold: true }) } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat)' } },
      { repeatCell: { range: grid(sheetId, dataStart, endRow, column, column + 1), cell: { userEnteredFormat: { ...fill(today ? '#F3F4F6' : '#FFF8E1'), textFormat: today ? text('#5F6368') : text('#243447') } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat.foregroundColorStyle)' } },
    );
  }
  if (today) {
    const zone = (first, last, color) => requests.push({ repeatCell: { range: grid(sheetId, headerRow, headerRow + 1, contract.columns.indexOf(first), contract.columns.indexOf(last) + 1), cell: { userEnteredFormat: { ...fill(color), textFormat: text('#FFFFFF',{bold:true}) } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat)' } });
    zone('Stage','Location','#27364B');
    zone('Attention Type','Allowed Actions','#35566B');
    zone('Human Decision','Outcome','#8A6D1D');
    zone('Evaluation','Job URL','#365B4A');
    zone('Movement','Why This Role','#4D6173');
  }

  const compactFields = ['Workflow Stage', 'Workflow Status', 'Attention Priority', 'Command Status', 'Rank', 'Movement', 'Current Rank', 'Research Priority', 'Evidence Confidence', 'Attention Status', 'State', 'Status', 'Package Status'];
  for (const field of compactFields) {
    const column = contract.columns.indexOf(field);
    if (column >= 0) requests.push({ repeatCell: { range: grid(sheetId, dataStart, endRow, column, column + 1), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: ['Rank', 'Current Rank', 'Attention Status'].includes(field) } } }, fields: 'userEnteredFormat(horizontalAlignment,textFormat.bold)' } });
  }
  for (const field of contract.columns.filter(column => column.includes('URL'))) {
    const column = contract.columns.indexOf(field);
    requests.push({ repeatCell: { range: grid(sheetId, dataStart, endRow, column, column + 1), cell: { userEnteredFormat: { wrapStrategy: 'CLIP', textFormat: text('#1967D2', { underline: true }) } }, fields: 'userEnteredFormat(wrapStrategy,textFormat)' } });
  }

  for (const field of contract.humanOwned) {
    const column = contract.columns.indexOf(field); const allowed = ({
      'TODAY.Human Decision': ['NO_ACTION', 'REJECT', 'HOLD', 'NEXT_STAGE'],
      'PIPELINE.Human Decision': ['NO_ACTION', 'REJECT', 'HOLD', 'NEXT_STAGE'],
      'TODAY.Rejection Reason': ['ROLE_NOT_RELEVANT','COMPANY_NOT_INTERESTING','COMPENSATION','GEOGRAPHY','EMPLOYMENT_MODEL','SCHEDULE','SENIORITY','STACK_MISMATCH','LANGUAGE_REQUIREMENT','POOL_OR_MARKETPLACE','LOW_QUALITY_POSTING','OTHER'],
      'PIPELINE.Rejection Reason': ['ROLE_NOT_RELEVANT','COMPANY_NOT_INTERESTING','COMPENSATION','GEOGRAPHY','EMPLOYMENT_MODEL','SCHEDULE','SENIORITY','STACK_MISMATCH','LANGUAGE_REQUIREMENT','POOL_OR_MARKETPLACE','LOW_QUALITY_POSTING','OTHER'],
      'TODAY.Application Decision': ['NO_ACTION', 'APPROVE_TO_APPLY', 'HOLD', 'REJECT'],
      'TODAY.Outreach Decision': ['NO_ACTION', 'APPROVE_OUTREACH', 'SKIP_OUTREACH', 'HOLD'],
      'TODAY.Human Resolution': ['CONFIRMED_APPLIED','NOT_APPLIED','KEEP_UNKNOWN'],
      'APPLICATIONS.Outcome': ['NO_OUTCOME','INTERVIEW','OFFER','HIRED','REJECTED','NO_RESPONSE','FAILED'],
      'COMMUNITIES.Membership Decision': ['NO_ACTION','WANT_TO_JOIN','JOINED','SKIP','REJECT'],
      'CONTACTS.Outreach Status': ['NOT_STARTED', 'PLANNED', 'CONTACTED', 'RESPONDED', 'CLOSED'],
      'CONTACTS.Outreach Outcome': ['UNKNOWN','NO_RESPONSE','REPLIED','RECRUITER_SCREEN','INTERVIEW','REFERRED','NEGATIVE'],
      'FOLLOW_UPS.Status': ['PENDING', 'DONE', 'CANCELLED'],
    })[`${name}.${field}`];
    if (allowed && !today) requests.push({ setDataValidation: { range: grid(sheetId, dataStart, endRow, column, column + 1), rule: { condition: { type: 'ONE_OF_LIST', values: allowed.map(userEnteredValue => ({ userEnteredValue })) }, strict: true, showCustomUi: true } } });
  }

  let ruleIndex = 0;
  if (name === 'TODAY') {
    addRule(requests, booleanRule([grid(sheetId,0,1,2,3)], 'NUMBER_EQ', '0', '#D9EFD9', {bold:true,foreground:'#175C2C'}), ruleIndex++);
    addRule(requests, booleanRule([grid(sheetId,0,1,2,3)], 'NUMBER_GREATER', '0', '#F9AB00', {bold:true,foreground:'#3C2A00'}), ruleIndex++);
    addRule(requests, booleanRule([grid(sheetId,0,1,4,5)], 'TEXT_EQ', 'HEALTHY', '#D9EFD9', {bold:true,foreground:'#175C2C'}), ruleIndex++);
    addRule(requests, booleanRule([grid(sheetId,0,1,6,7)], 'TEXT_CONTAINS', 'SUCCESS', '#D9EFD9', {bold:true,foreground:'#175C2C'}), ruleIndex++);
    const attentionType=contract.columns.indexOf('Attention Type'),attentionTypeRange=grid(sheetId,dataStart,endRow,attentionType,attentionType+1);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'VERIFICATION_REQUIRED', '#F9AB00', {bold:true,foreground:'#3C2A00'}), ruleIndex++);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'ANSWER_REQUIRED', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'APPROVAL_REQUIRED', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'REVIEW_REQUIRED', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'DECISION_REQUIRED', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'FOLLOW_UP_REQUIRED', '#F1ECF8', {bold:true,foreground:'#5B3A82'}), ruleIndex++);
    addRule(requests, booleanRule([attentionTypeRange], 'TEXT_EQ', 'EXTERNAL_ACTION_REQUIRED', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);
    const lane=contract.columns.indexOf('Lane'),laneRange=grid(sheetId,dataStart,endRow,lane,lane+1);
    addRule(requests, booleanRule([laneRange], 'TEXT_EQ', 'ATTENTION', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);
    addRule(requests, booleanRule([laneRange], 'TEXT_EQ', 'CURATED', '#E8F0FE', {bold:true,foreground:'#174EA6'}), ruleIndex++);
    const humanStatus=contract.columns.indexOf('Status'),humanStatusRange=grid(sheetId,dataStart,endRow,humanStatus,humanStatus+1);
    addRule(requests, booleanRule([humanStatusRange], 'TEXT_EQ', 'WAITING_FOR_YOU', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([humanStatusRange], 'TEXT_EQ', 'WORKING', '#E8F0FE', {bold:true,foreground:'#174EA6'}), ruleIndex++);
    addRule(requests, booleanRule([humanStatusRange], 'TEXT_EQ', 'QUEUED', '#F1ECF8', {bold:true,foreground:'#5B3A82'}), ruleIndex++);
    addRule(requests, booleanRule([humanStatusRange], 'TEXT_EQ', 'BLOCKED', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);
    addRule(requests, booleanRule([humanStatusRange], 'TEXT_EQ', 'ON_HOLD', '#F1F3F4', {foreground:'#5F6368'}), ruleIndex++);

    const attentionLetter=sheetColumn(attentionType),allowedLetter=sheetColumn(contract.columns.indexOf('Allowed Actions')),humanDecision=contract.columns.indexOf('Human Decision'),humanDecisionLetter=sheetColumn(humanDecision);
    const active = (field, formula) => { const column=contract.columns.indexOf(field); addRule(requests, customRule([grid(sheetId,dataStart,endRow,column,column+1)],formula,'#FFF2CC',{bold:true,foreground:'#3C2A00'}),ruleIndex++); };
    active('Human Decision',`=OR($${attentionLetter}${formulaRow}="DECISION_REQUIRED",AND($${attentionLetter}${formulaRow}="REVIEW_REQUIRED",REGEXMATCH($${allowedLetter}${formulaRow},"NEXT_STAGE")))`);
    active('Rejection Reason',`=AND(OR($${attentionLetter}${formulaRow}="DECISION_REQUIRED",$${attentionLetter}${formulaRow}="REVIEW_REQUIRED"),$${humanDecisionLetter}${formulaRow}="REJECT")`);
    active('Application Decision',`=AND(OR($${attentionLetter}${formulaRow}="REVIEW_REQUIRED",$${attentionLetter}${formulaRow}="APPROVAL_REQUIRED"),REGEXMATCH($${allowedLetter}${formulaRow},"APPROVE_TO_APPLY"))`);
    active('Human Answer',`=$${attentionLetter}${formulaRow}="ANSWER_REQUIRED"`);
    active('Human Resolution',`=$${attentionLetter}${formulaRow}="VERIFICATION_REQUIRED"`);
    active('Resolution Notes',`=$${attentionLetter}${formulaRow}="VERIFICATION_REQUIRED"`);
    for(const field of ['Follow-Up Date','Follow-Up Action','Notes','Outcome'])active(field,`=$${attentionLetter}${formulaRow}="FOLLOW_UP_REQUIRED"`);

    const status = contract.columns.indexOf('Attention Status');
    const careerRange = grid(sheetId, dataStart, endRow, 0, contract.columns.indexOf('Human Decision'));
    const statusRange = grid(sheetId, dataStart, endRow, status, status + 1);
    const statusLetter=sheetColumn(status),lifecycle=contract.columns.indexOf('Lifecycle State'),lifecycleRange=grid(sheetId,dataStart,endRow,lifecycle,lifecycle+1);
    addRule(requests, customRule([careerRange], `=$${statusLetter}${formulaRow}="ACTION_READY"`, '#EDF7EF'), ruleIndex++);
    addRule(requests, customRule([careerRange], `=$${statusLetter}${formulaRow}="REVIEW_REQUIRED"`, '#FFF7E6'), ruleIndex++);
    addRule(requests, customRule([careerRange], `=$${statusLetter}${formulaRow}="RESEARCH_REQUIRED"`, '#F3F6F8'), ruleIndex++);
    addRule(requests, booleanRule([statusRange], 'TEXT_EQ', 'ACTION_READY', '#D9EFD9', { bold: true, foreground: '#175C2C' }), ruleIndex++);
    addRule(requests, booleanRule([statusRange], 'TEXT_EQ', 'REVIEW_REQUIRED', '#FCE8B2', { bold: true, foreground: '#7A4B00' }), ruleIndex++);
    addRule(requests, booleanRule([statusRange], 'TEXT_EQ', 'RESEARCH_REQUIRED', '#E8EEF3', { bold: true, foreground: '#4D6173' }), ruleIndex++);
    const movement = contract.columns.indexOf('Movement');
    addRule(requests, booleanRule([grid(sheetId, dataStart, endRow, movement, movement + 1)], 'TEXT_EQ', 'NEW', '#E8F0FE', { bold: true, foreground: '#174EA6' }), ruleIndex++);
    addRule(requests, booleanRule([lifecycleRange], 'TEXT_EQ', 'NEEDS_HUMAN', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([lifecycleRange], 'TEXT_EQ', 'READY_FOR_REVIEW', '#D9EFD9', {bold:true,foreground:'#175C2C'}), ruleIndex++);
    addRule(requests, booleanRule([lifecycleRange], 'TEXT_EQ', 'EXECUTING', '#E8F0FE', {bold:true,foreground:'#174EA6'}), ruleIndex++);
    addRule(requests, booleanRule([lifecycleRange], 'TEXT_EQ', 'HOLD', '#F1F3F4', {foreground:'#5F6368'}), ruleIndex++);
    const workflowStatus=contract.columns.indexOf('Workflow Status'),workflowRange=grid(sheetId,dataStart,endRow,workflowStatus,workflowStatus+1);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'WAITING_FOR_HUMAN', '#FCE8B2', {bold:true,foreground:'#7A4B00'}), ruleIndex++);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'READY_FOR_REVIEW', '#D9EFD9', {bold:true,foreground:'#175C2C'}), ruleIndex++);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'PROCESSING', '#E8F0FE', {bold:true,foreground:'#174EA6'}), ruleIndex++);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'QUEUED', '#F1ECF8', {bold:true,foreground:'#5B3A82'}), ruleIndex++);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'FAILED', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'BLOCKED', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);
    const commandStatus=contract.columns.indexOf('Command Status'),commandRange=grid(sheetId,dataStart,endRow,commandStatus,commandStatus+1);
    addRule(requests, booleanRule([commandRange], 'TEXT_EQ', 'SUCCESS', '#D9EFD9', {bold:true,foreground:'#175C2C'}), ruleIndex++);
    addRule(requests, booleanRule([commandRange], 'TEXT_EQ', 'FAILED', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);

    for(const field of ['Resume','Cover Letter']){
      const column=contract.columns.indexOf(field),range=grid(sheetId,dataStart,endRow,column,column+1);
      addRule(requests, booleanRule([range], 'TEXT_STARTS_WITH', 'READY ·', '#EAF4EA', {bold:true,foreground:'#1967D2'}), ruleIndex++);
      addRule(requests, booleanRule([range], 'TEXT_STARTS_WITH', 'NOT_GENERATED', '#F1F3F4', {foreground:'#80868B'}), ruleIndex++);
      addRule(requests, booleanRule([range], 'TEXT_STARTS_WITH', 'SUPERSEDED', '#F1F3F4', {foreground:'#80868B'}), ruleIndex++);
      addRule(requests, booleanRule([range], 'TEXT_STARTS_WITH', 'ERROR', '#FDECEC', {bold:true,foreground:'#8C1D18'}), ruleIndex++);
    }
  }
  if (name === 'PIPELINE') {
    const status = contract.columns.indexOf('Attention Status');
    const statusRange = grid(sheetId, 1, endRow, status, status + 1);
    addRule(requests, booleanRule([statusRange], 'TEXT_EQ', 'ACTION_READY', '#E3F2E6', { bold: true, foreground: '#175C2C' }), ruleIndex++);
    addRule(requests, booleanRule([statusRange], 'TEXT_EQ', 'REVIEW_REQUIRED', '#FCE8B2', { bold: true, foreground: '#7A4B00' }), ruleIndex++);
    addRule(requests, booleanRule([statusRange], 'TEXT_EQ', 'RESEARCH_REQUIRED', '#EEF2F5', { foreground: '#4D6173' }), ruleIndex++);
    const state = contract.columns.indexOf('State');
    addRule(requests, booleanRule([grid(sheetId, 1, endRow, state, state + 1)], 'TEXT_EQ', 'ACTIVE', '#E8F0FE', { bold: true, foreground: '#174EA6' }), ruleIndex++);
    addRule(requests, booleanRule([grid(sheetId, 1, endRow, state, state + 1)], 'TEXT_EQ', 'CARRYOVER', '#F1F3F4', { foreground: '#5F6368' }), ruleIndex++);
  }
  if (['TODAY', 'PIPELINE'].includes(name)) {
    const outcome = contract.columns.indexOf('Decision Outcome');
    const outcomeRange = grid(sheetId, dataStart, endRow, outcome, outcome + 1);
    addRule(requests, booleanRule([outcomeRange], 'TEXT_EQ', 'REJECTED', '#FDECEC', { bold: true, foreground: '#8C1D18' }), ruleIndex++);
    addRule(requests, booleanRule([outcomeRange], 'TEXT_EQ', 'HELD', '#FFF4E5', { bold: true, foreground: '#8A5A00' }), ruleIndex++);
    addRule(requests, booleanRule([outcomeRange], 'TEXT_EQ', 'ENRICHMENT_QUEUED', '#E8F0FE', { bold: true, foreground: '#174EA6' }), ruleIndex++);
    const confidence = contract.columns.indexOf('Evidence Confidence');
    const confidenceRange = grid(sheetId, dataStart, endRow, confidence, confidence + 1);
    addRule(requests, booleanRule([confidenceRange], 'TEXT_EQ', 'HIGH', '#EAF4EA', { foreground: '#286C35' }), ruleIndex++);
    addRule(requests, booleanRule([confidenceRange], 'TEXT_EQ', 'MEDIUM', '#EEF3F8', { foreground: '#496579' }), ruleIndex++);
    addRule(requests, booleanRule([confidenceRange], 'TEXT_EQ', 'LOW', '#FFF4E5', { foreground: '#8A5A00' }), ruleIndex++);
  }
  if (name === 'RESEARCH') {
    const priority = contract.columns.indexOf('Research Priority');
    addRule(requests, booleanRule([grid(sheetId, 1, endRow, priority, priority + 1)], 'TEXT_EQ', 'HIGH', '#E8F0FE', { bold: true, foreground: '#174EA6' }), ruleIndex++);
    const rank = contract.columns.indexOf('Current Rank');
    addRule(requests, customRule([grid(sheetId, 1, endRow, rank, rank + 1)], '=AND(ISNUMBER($D2),$D2<=10)', '#EEF4FD', { bold: true, foreground: '#174EA6' }), ruleIndex++);
  }
  if (name === 'COMMUNITIES') {
    const membership = contract.columns.indexOf('Membership State');
    const membershipRange = grid(sheetId, 1, endRow, membership, membership + 1);
    addRule(requests, booleanRule([membershipRange], 'TEXT_EQ', 'NEEDS_HUMAN', '#FCE8B2', { bold: true, foreground: '#7A4B00' }), ruleIndex++);
    addRule(requests, booleanRule([membershipRange], 'TEXT_EQ', 'JOIN_REQUESTED', '#E8F0FE', { bold: true, foreground: '#174EA6' }), ruleIndex++);
    addRule(requests, booleanRule([membershipRange], 'TEXT_EQ', 'VERIFICATION_UNKNOWN', '#FFF4E5', { foreground: '#8A5A00' }), ruleIndex++);
    addRule(requests, booleanRule([membershipRange], 'TEXT_EQ', 'JOINED_CONFIRMED', '#D9EFD9', { bold: true, foreground: '#175C2C' }), ruleIndex++);
    const workflowStatus=contract.columns.indexOf('Workflow Status'),workflowRange=grid(sheetId,1,endRow,workflowStatus,workflowStatus+1);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'WAITING_FOR_HUMAN', '#FCE8B2', { bold:true, foreground:'#7A4B00' }), ruleIndex++);
    addRule(requests, booleanRule([workflowRange], 'TEXT_EQ', 'COMPLETED', '#D9EFD9', { bold:true, foreground:'#175C2C' }), ruleIndex++);
  }
  if (name === 'APPLICATIONS') { const applicationStatus=contract.columns.indexOf('Application Status'); addRule(requests, booleanRule([grid(sheetId,1,endRow,applicationStatus,applicationStatus+1)],'TEXT_EQ','APPLIED','#D9EFD9',{bold:true,foreground:'#175C2C'}),ruleIndex++); }

  const idIndex = contract.columns.indexOf('Entity ID');
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: idIndex >= 0 ? idIndex : width }, properties: { hiddenByUser: false }, fields: 'hiddenByUser' } });
  if(name==='TODAY')for(const field of ['Lane','Final Priority','Workflow Stage','Workflow Status','Last Command','Command Status','Command Result','Attention Status','Enrichment Summary','Last Enriched','Human Blocker','Lifecycle State','Decision Outcome','Enrichment Status','Execution Status','Entity Type','Job ID','Question ID']){const column=contract.columns.indexOf(field);requests.push({updateDimensionProperties:{range:{sheetId,dimension:'COLUMNS',startIndex:column,endIndex:column+1},properties:{hiddenByUser:true},fields:'hiddenByUser'}});}
  if (idIndex >= 0) requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: idIndex, endIndex: width }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  return requests;
}

export function buildReadmeFormatRequests(sheet) {
  const sheetId=sheet.properties.sheetId,requests=[
    {unmergeCells:{range:grid(sheetId,0,130,0,8)}},
    {updateSheetProperties:{properties:{sheetId,gridProperties:{hideGridlines:true,frozenRowCount:0}},fields:'gridProperties(hideGridlines,frozenRowCount)'}},
    {repeatCell:{range:grid(sheetId,0,130,0,8),cell:{userEnteredFormat:{...fill('#FFFFFF'),verticalAlignment:'MIDDLE',wrapStrategy:'WRAP',textFormat:text('#243447',{fontFamily:'Arial',fontSize:10})}},fields:'userEnteredFormat'}},
    {updateDimensionProperties:{range:{sheetId,dimension:'ROWS',startIndex:0,endIndex:130},properties:{pixelSize:10},fields:'pixelSize'}},
  ];
  const merge=(row,start=0,end=8)=>requests.push({mergeCells:{range:grid(sheetId,row,row+1,start,end),mergeType:'MERGE_ALL'}});
  const full=[0,1,3,4,5,6,7,8,10,19,21,22,23,24,26,35,40,47,53,54,55,57,64,70,75,85,86,87,92,93,95,102,104,112,113,115,116,118,119,120,121];
  full.forEach(row=>merge(row));
  for(const row of [...Array.from({length:8},(_,i)=>11+i),...Array.from({length:7},(_,i)=>27+i),36,37,38,58,59,60,61,62,65,66,67,68,71,72,73]){merge(row,0,2);merge(row,2,8);}
  for(const row of [41,42,43,44,45]){merge(row,0,2);merge(row,2,4);merge(row,4,8);}
  for(const row of [48,49,50,51]){merge(row,0,2);merge(row,2,5);merge(row,5,8);}
  for(const row of [76,77,78,79,80,81,82,83]){merge(row,0,2);merge(row,2,4);merge(row,4,6);merge(row,6,8);}
  for(const row of [89,90]){merge(row,0,4);merge(row,4,8);}
  for(const row of [96,97,98,99,100,101]){merge(row,0,2);merge(row,2,6);merge(row,6,8);}
  for(const row of [105,106,107,108,109,110]){merge(row,1,4);merge(row,5,8);}
  requests.push(
    {repeatCell:{range:grid(sheetId,0,2,0,8),cell:{userEnteredFormat:{...fill('#17324D'),textFormat:text('#FFFFFF',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,0,1,0,8),cell:{userEnteredFormat:{textFormat:{fontSize:22,bold:true}}},fields:'userEnteredFormat.textFormat(fontSize,bold)'}},
    {repeatCell:{range:grid(sheetId,1,2,0,8),cell:{userEnteredFormat:{textFormat:{fontSize:12,bold:false}}},fields:'userEnteredFormat.textFormat(fontSize,bold)'}},
    {repeatCell:{range:grid(sheetId,3,9,0,8),cell:{userEnteredFormat:{...fill('#EAF4EA')}},fields:'userEnteredFormat.backgroundColorStyle'}},
    {repeatCell:{range:grid(sheetId,3,4,0,8),cell:{userEnteredFormat:{...fill('#1E6B42'),textFormat:text('#FFFFFF',{fontSize:12,bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,4,5,0,8),cell:{userEnteredFormat:{textFormat:text('#175C2C',{fontSize:14,bold:true})}},fields:'userEnteredFormat.textFormat'}},
    {repeatCell:{range:grid(sheetId,7,8,0,8),cell:{userEnteredFormat:{...fill('#D9EFD9'),textFormat:text('#175C2C',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
  );
  const sectionRows=[10,21,26,35,40,47,53,57,64,70,75,85,92,95,104,112,115,118];
  for(const row of sectionRows)requests.push({repeatCell:{range:grid(sheetId,row,row+1,0,8),cell:{userEnteredFormat:{...fill('#DCEAF3'),textFormat:text('#17324D',{bold:true,fontSize:11})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}});
  const tableHeaders=[41,48,76,96,105];
  for(const row of tableHeaders)requests.push({repeatCell:{range:grid(sheetId,row,row+1,0,8),cell:{userEnteredFormat:{...fill('#27364B'),textFormat:text('#FFFFFF',{bold:true}),horizontalAlignment:'CENTER'}},fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)'}});
  requests.push(
    {repeatCell:{range:grid(sheetId,11,19,0,2),cell:{userEnteredFormat:{...fill('#E8F0FE'),textFormat:text('#174EA6',{bold:true}),horizontalAlignment:'CENTER'}},fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)'}},
    {repeatCell:{range:grid(sheetId,27,34,0,2),cell:{userEnteredFormat:{...fill('#F3F6F8'),textFormat:{bold:true}}},fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)'}},
    {repeatCell:{range:grid(sheetId,35,39,0,8),cell:{userEnteredFormat:{...fill('#FFF8E1')}},fields:'userEnteredFormat.backgroundColorStyle'}},
    {repeatCell:{range:grid(sheetId,36,39,0,2),cell:{userEnteredFormat:{...fill('#F9AB00'),textFormat:text('#3C2A00',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,49,50,0,8),cell:{userEnteredFormat:{...fill('#EAF4EA')}},fields:'userEnteredFormat.backgroundColorStyle'}},
    {repeatCell:{range:grid(sheetId,50,51,0,8),cell:{userEnteredFormat:{...fill('#E8F0FE')}},fields:'userEnteredFormat.backgroundColorStyle'}},
    {repeatCell:{range:grid(sheetId,51,52,0,8),cell:{userEnteredFormat:{...fill('#FFF4E5')}},fields:'userEnteredFormat.backgroundColorStyle'}},
    {repeatCell:{range:grid(sheetId,71,74,0,2),cell:{userEnteredFormat:{...fill('#FDECEC'),textFormat:text('#8C1D18',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,77,84,0,2),cell:{userEnteredFormat:{...fill('#E8F0FE'),textFormat:text('#174EA6',{bold:true}),horizontalAlignment:'CENTER'}},fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)'}},
    {repeatCell:{range:grid(sheetId,85,88,0,8),cell:{userEnteredFormat:{...fill('#FFF8E1')}},fields:'userEnteredFormat.backgroundColorStyle'}},
    {repeatCell:{range:grid(sheetId,89,90,0,4),cell:{userEnteredFormat:{...fill('#1E6B42'),textFormat:text('#FFFFFF',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,89,90,4,8),cell:{userEnteredFormat:{...fill('#B3261E'),textFormat:text('#FFFFFF',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,90,91,0,4),cell:{userEnteredFormat:{...fill('#EAF4EA'),textFormat:text('#243447')}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,90,91,4,8),cell:{userEnteredFormat:{...fill('#FDECEC'),textFormat:text('#243447')}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,97,102,0,2),cell:{userEnteredFormat:{...fill('#E8F0FE'),textFormat:text('#174EA6',{bold:true}),horizontalAlignment:'CENTER'}},fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)'}},
    {repeatCell:{range:grid(sheetId,106,111,0,1),cell:{userEnteredFormat:{...fill('#F3F6F8'),textFormat:{bold:true}}},fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)'}},
    {repeatCell:{range:grid(sheetId,106,111,4,5),cell:{userEnteredFormat:{...fill('#F3F6F8'),textFormat:{bold:true}}},fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)'}},
    {repeatCell:{range:grid(sheetId,118,122,0,8),cell:{userEnteredFormat:{...fill('#EAF4EA'),textFormat:text('#175C2C',{bold:true})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
    {repeatCell:{range:grid(sheetId,118,119,0,8),cell:{userEnteredFormat:{...fill('#1E6B42'),textFormat:text('#FFFFFF',{bold:true,fontSize:12})}},fields:'userEnteredFormat(backgroundColorStyle,textFormat)'}},
  );
  [118,118,125,125,145,125,118,118].forEach((pixelSize,index)=>requests.push({updateDimensionProperties:{range:{sheetId,dimension:'COLUMNS',startIndex:index,endIndex:index+1},properties:{pixelSize},fields:'pixelSize'}}));
  const populated=new Set();for(let row=0;row<122;row++)if(![2,9,20,25,34,39,46,52,56,63,69,74,84,88,91,94,103,111,114,117].includes(row))populated.add(row);
  for(const row of populated){const long=[6,8,18,19,23,24,49,50,51,54,55,76,77,78,79,80,81,82,83,86,87,90,106,107,108,109,110,116,120,121].includes(row);requests.push({updateDimensionProperties:{range:{sheetId,dimension:'ROWS',startIndex:row,endIndex:row+1},properties:{pixelSize:long?72:40},fields:'pixelSize'}});}
  return requests;
}

function buildLegacyReadmeFormatRequests(sheet) {
  const sheetId = sheet.properties.sheetId;
  const requests = [
    { unmergeCells: { range: grid(sheetId, 0, 100, 0, 8) } },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { hideGridlines: true, frozenRowCount: 0 } }, fields: 'gridProperties(hideGridlines,frozenRowCount)' } },
    { repeatCell: { range: grid(sheetId, 0, 100, 0, 8), cell: { userEnteredFormat: { ...fill('#FFFFFF'), verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP', textFormat: text('#243447', { fontFamily: 'Arial', fontSize: 10 }) } }, fields: 'userEnteredFormat' } },
    { updateDimensionProperties: { range: { sheetId, dimension:'ROWS', startIndex:0, endIndex:100 }, properties:{pixelSize:10}, fields:'pixelSize' } },
  ];
  const fullRows = [0,1,3,4,5,6,8,14,24,25,26,28,29,33,36,37,42,43,45,46,48,53,55,59,60,61,62,63,65,73,85,86,88,89,90,91];
  const merges = fullRows.map(row=>[row,row+1,0,8]);
  for (const row of [9,10,11,12,30,31,49,50,51,52,74,75,76,77,78,79,80,81,82,83,84]) {
    merges.push([row,row+1,0,2],[row,row+1,2,8]);
  }
  for (const row of [15,16,17,18,19,20,21,22]) {
    merges.push([row,row+1,0,2],[row,row+1,2,4],[row,row+1,4,6],[row,row+1,6,8]);
  }
  for (const row of [34,35,39,40,56,57]) merges.push([row,row+1,0,4],[row,row+1,4,8]);
  for (const row of [66,67,68,69,70,71]) merges.push([row,row+1,0,2],[row,row+1,2,6],[row,row+1,6,8]);
  for (const [startRowIndex,endRowIndex,startColumnIndex,endColumnIndex] of merges) requests.push({ mergeCells: { range: grid(sheetId,startRowIndex,endRowIndex,startColumnIndex,endColumnIndex), mergeType: 'MERGE_ALL' } });
  requests.push(
    { repeatCell: { range: grid(sheetId,0,2,0,8), cell: { userEnteredFormat: { ...fill('#17324D'), textFormat: text('#FFFFFF',{bold:true}) } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat)' } },
    { repeatCell: { range: grid(sheetId,0,1,0,8), cell: { userEnteredFormat: { textFormat: { fontSize: 22, bold: true } } }, fields: 'userEnteredFormat.textFormat(fontSize,bold)' } },
    { repeatCell: { range: grid(sheetId,1,2,0,8), cell: { userEnteredFormat: { textFormat: { fontSize: 12, bold: false } } }, fields: 'userEnteredFormat.textFormat(fontSize,bold)' } },
    { repeatCell: { range: grid(sheetId,3,7,0,8), cell: { userEnteredFormat: { ...fill('#EAF4EA') } }, fields: 'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,3,4,0,8), cell: { userEnteredFormat: { ...fill('#1E6B42'), textFormat: text('#FFFFFF',{fontSize:12,bold:true}) } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat)' } },
    { repeatCell: { range: grid(sheetId,4,5,0,8), cell: { userEnteredFormat: { textFormat: text('#175C2C',{fontSize:14,bold:true}) } }, fields: 'userEnteredFormat.textFormat' } },
    { repeatCell: { range: grid(sheetId,5,7,0,8), cell: { userEnteredFormat: { textFormat: text('#17324D',{fontSize:12,bold:true}) } }, fields: 'userEnteredFormat.textFormat' } },
  );
  for (const row of [8,14,28,33,42,45,48,55,59,65,73,85]) requests.push({ repeatCell: { range: grid(sheetId,row,row+1,0,8), cell: { userEnteredFormat: { ...fill('#DCEAF3'), textFormat: text('#17324D',{bold:true,fontSize:11}) } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat)' } });
  requests.push(
    { repeatCell: { range: grid(sheetId,9,13,0,2), cell: { userEnteredFormat: { ...fill('#F3F6F8'), textFormat: { bold:true } } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat.bold)' } },
    { repeatCell: { range: grid(sheetId,15,16,0,8), cell: { userEnteredFormat: { ...fill('#27364B'), textFormat: text('#FFFFFF',{bold:true}), horizontalAlignment:'CENTER' } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,16,23,0,8), cell: { userEnteredFormat: { ...fill('#F8FAFC') } }, fields: 'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,16,23,0,2), cell: { userEnteredFormat: { ...fill('#E8F0FE'), textFormat: text('#174EA6',{bold:true}), horizontalAlignment:'CENTER' } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,24,27,0,8), cell: { userEnteredFormat: { ...fill('#FFF8E1') } }, fields: 'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,24,25,0,8), cell: { userEnteredFormat: { ...fill('#F9AB00'), textFormat: text('#3C2A00',{bold:true,fontSize:11}) } }, fields: 'userEnteredFormat(backgroundColorStyle,textFormat)' } },
    { repeatCell: { range: grid(sheetId,30,32,0,2), cell: { userEnteredFormat: { textFormat:{bold:true}, horizontalAlignment:'CENTER' } }, fields: 'userEnteredFormat(textFormat.bold,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,30,31,0,8), cell: { userEnteredFormat: { ...fill('#EAF4EA') } }, fields: 'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,31,32,0,8), cell: { userEnteredFormat: { ...fill('#FDECEC') } }, fields: 'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,34,35,0,4), cell: { userEnteredFormat: { ...fill('#27364B'), textFormat:text('#FFFFFF',{bold:true}), horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,34,35,4,8), cell: { userEnteredFormat: { ...fill('#1E6B42'), textFormat:text('#FFFFFF',{bold:true}), horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,35,36,0,4), cell: { userEnteredFormat: { ...fill('#E8F0FE') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,35,36,4,8), cell: { userEnteredFormat: { ...fill('#EAF4EA') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,36,37,0,8), cell: { userEnteredFormat: { ...fill('#EEF3F8'), textFormat:{bold:true} } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)' } },
    { repeatCell: { range: grid(sheetId,39,40,0,4), cell: { userEnteredFormat: { ...fill('#1E6B42'), textFormat:text('#FFFFFF',{bold:true}), horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,39,40,4,8), cell: { userEnteredFormat: { ...fill('#B3261E'), textFormat:text('#FFFFFF',{bold:true}), horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,40,41,0,4), cell: { userEnteredFormat: { ...fill('#EAF4EA') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,40,41,4,8), cell: { userEnteredFormat: { ...fill('#FDECEC') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,49,50,0,8), cell: { userEnteredFormat: { ...fill('#27364B'), textFormat:text('#FFFFFF',{bold:true}) } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat)' } },
    { repeatCell: { range: grid(sheetId,50,53,0,2), cell: { userEnteredFormat: { ...fill('#FFF4E5'), textFormat:{bold:true} } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)' } },
    { repeatCell: { range: grid(sheetId,53,54,0,8), cell: { userEnteredFormat: { ...fill('#FDECEC'), textFormat:{bold:true} } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)' } },
    { repeatCell: { range: grid(sheetId,56,58,0,4), cell: { userEnteredFormat: { ...fill('#F3F6F8'), textFormat:{bold:true} } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)' } },
    { repeatCell: { range: grid(sheetId,56,57,4,8), cell: { userEnteredFormat: { ...fill('#EAF4EA') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,57,58,4,8), cell: { userEnteredFormat: { ...fill('#FFF4E5') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,60,64,0,8), cell: { userEnteredFormat: { ...fill('#F8FAFC') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,60,63,0,8), cell: { userEnteredFormat: { textFormat:{bold:true} } }, fields:'userEnteredFormat.textFormat.bold' } },
    { repeatCell: { range: grid(sheetId,66,67,0,8), cell: { userEnteredFormat: { ...fill('#27364B'), textFormat:text('#FFFFFF',{bold:true}), horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,67,72,0,2), cell: { userEnteredFormat: { ...fill('#E8F0FE'), textFormat:text('#174EA6',{bold:true}), horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment)' } },
    { repeatCell: { range: grid(sheetId,74,75,0,8), cell: { userEnteredFormat: { ...fill('#27364B'), textFormat:text('#FFFFFF',{bold:true}) } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat)' } },
    { repeatCell: { range: grid(sheetId,75,84,0,2), cell: { userEnteredFormat: { ...fill('#F3F6F8'), textFormat:{bold:true} } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat.bold)' } },
    { repeatCell: { range: grid(sheetId,86,87,0,8), cell: { userEnteredFormat: { ...fill('#F3F6F8') } }, fields:'userEnteredFormat.backgroundColorStyle' } },
    { repeatCell: { range: grid(sheetId,88,92,0,8), cell: { userEnteredFormat: { ...fill('#EAF4EA'), textFormat:text('#175C2C',{bold:true}) } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat)' } },
    { repeatCell: { range: grid(sheetId,88,89,0,8), cell: { userEnteredFormat: { ...fill('#1E6B42'), textFormat:text('#FFFFFF',{bold:true,fontSize:12}) } }, fields:'userEnteredFormat(backgroundColorStyle,textFormat)' } },
  );
  [118,118,125,125,125,125,118,118].forEach((pixelSize,index)=>requests.push({ updateDimensionProperties: { range: { sheetId, dimension:'COLUMNS', startIndex:index, endIndex:index+1 }, properties:{pixelSize}, fields:'pixelSize' } }));
  const heights = {
    0:44,1:28,3:30,4:36,5:34,6:56,8:30,
    9:38,10:38,11:42,12:42,14:30,15:34,
    16:64,17:78,18:70,19:70,20:88,21:70,22:84,
    24:30,25:54,26:42,28:30,29:48,30:36,31:40,
    33:30,34:34,35:100,36:30,37:58,39:38,40:130,
    42:30,43:66,45:30,46:62,48:30,49:34,50:42,51:42,52:42,53:40,
    55:30,56:56,57:66,59:30,60:34,61:34,62:34,63:46,
    65:30,66:34,67:48,68:72,69:54,70:58,71:66,
    73:30,74:34,75:36,76:36,77:40,78:42,79:36,80:36,81:36,82:36,83:44,
    85:30,86:54,88:30,89:34,90:42,91:34,
  };
  for (const [row,pixelSize] of Object.entries(heights)) requests.push({ updateDimensionProperties: { range: { sheetId, dimension:'ROWS', startIndex:Number(row), endIndex:Number(row)+1 }, properties:{pixelSize}, fields:'pixelSize' } });
  return requests;
}
