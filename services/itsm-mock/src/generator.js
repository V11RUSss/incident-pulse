const SCENARIO_COUNT = 12;
const CRITICAL_EVERY = 12;

function automaticPriority(affectedUsers) {
  if (affectedUsers >= 1000) return 4;
  if (affectedUsers >= 500) return 3;
  if (affectedUsers >= 50) return 2;
  return 1;
}

function createRecord(now, input) {
  return {
    id: input.id,
    correlationKey: input.correlationKey,
    header: input.header,
    description: input.description,
    productName: input.productName,
    service: input.service,
    scenarioName: input.scenarioName,
    region: input.region,
    affectedUsers: input.affectedUsers,
    reportCount: input.reportCount,
    priorityId: automaticPriority(input.affectedUsers),
    priorityOverrideId: null,
    stateId: input.stateId ?? 0,
    submitDate: now,
    deadline: input.deadline ?? new Date(Date.parse(now) + 30 * 60 * 1000).toISOString(),
    completionDate: null,
    assignedGroupName: input.assignedGroupName ?? null,
    coordinatorId: null,
    coordinatorName: null,
    solution: null,
    isNeedUp: input.isNeedUp ?? false,
    isMaster: input.isMaster ?? false,
    isEffect: input.isEffect ?? false,
    version: 1,
    updatedAt: now,
  };
}

function updateRecord(existing, now, changes) {
  const affectedUsers = changes.affectedUsers ?? existing.affectedUsers;
  const stateId = changes.stateId ?? existing.stateId;
  const priorityOverrideId = (Object.hasOwn(changes, 'priorityOverrideId')
    ? changes.priorityOverrideId
    : existing.priorityOverrideId) ?? null;
  const priorityId = Object.hasOwn(changes, 'priorityId')
    ? changes.priorityId
    : priorityOverrideId ?? automaticPriority(affectedUsers);

  const record = {
    ...existing,
    ...changes,
    affectedUsers,
    priorityId,
    priorityOverrideId,
    stateId,
    version: existing.version + 1,
    updatedAt: now,
  };

  if (stateId === 0 || stateId === 2) {
    record.solution = null;
    record.completionDate = null;
  } else if (stateId === 20) {
    record.completionDate = null;
  } else if ((stateId === 7 || stateId === 10) && !record.completionDate) {
    record.completionDate = now;
  }
  return record;
}

function add(records, id, now, input) {
  const existing = records.get(id);
  if (existing) {
    return {
      added: false,
      record: updateRecord(existing, now, {
        affectedUsers: existing.affectedUsers + (input.growth ?? 5),
        reportCount: existing.reportCount + 1,
      }),
    };
  }
  return { added: true, record: createRecord(now, { ...input, id }) };
}

const RECOVERY_BASE_STEP_BY_ID = Object.freeze({
  'MTS-MOBILE-0001': 0,
  'MTS-MOBILE-0002': 2,
  'MTS-ID-0001': 3,
  'MTS-BANK-0001': 4,
  'MTS-SMS-0001': 5,
  'MTS-KION-0001': 6,
  'MTS-CLOUD-0001': 7,
  'MTS-MOBILE-0003': 8,
});

function recreateInitialRecord(id, now) {
  const baseStep = RECOVERY_BASE_STEP_BY_ID[id];
  if (baseStep === undefined) {
    throw new Error(`Demo scenario is missing ${id}`);
  }
  // Base steps only create their record, so this replay never calls change() again.
  return generateInitialIncident(new Map(), baseStep, now).record;
}

function change(records, id, now, changes) {
  const existing = records.get(id);
  const recovered = existing === undefined;
  const target = existing ?? recreateInitialRecord(id, now);
  const resolved = typeof changes === 'function' ? changes(target) : changes;
  return {
    added: recovered,
    recovered,
    record: updateRecord(target, now, resolved),
  };
}

function generateInitialIncident(records, step, now) {
  switch (step) {
    case 0:
      return add(records, 'MTS-MOBILE-0001', now, {
        correlationKey: 'mobile-voice-moscow-outage',
        header: 'Деградация голосовой связи в Москве',
        description: 'Абоненты сообщают о обрывах и невозможности установить голосовое соединение. Мониторинг подтверждает рост неуспешных вызовов.',
        productName: 'Mobile voice',
        service: 'Голосовая связь',
        scenarioName: 'Установление голосового соединения',
        region: 'Москва',
        affectedUsers: 10,
        reportCount: 4,
        growth: 25,
        deadline: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
        isMaster: true,
        isEffect: true,
      });
    case 1:
      return change(records, 'MTS-MOBILE-0001', now, (existing) => ({
        affectedUsers: Math.max(1000, existing.affectedUsers),
        reportCount: existing.reportCount + 5,
        description: 'Деградация распространилась на несколько коммутаторов. Зафиксирован массовый рост неуспешных вызовов, включён аварийный контур мониторинга.',
        deadline: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
      }));
    case 2:
      return add(records, 'MTS-MOBILE-0002', now, {
        correlationKey: 'mobile-voice-moscow-regional',
        header: 'Обрывы голосовых вызовов в Москве',
        description: 'Абоненты сообщают об обрывах и невозможности установить голосовое соединение. Поток жалоб из Москвы продолжает расти, мониторинг фиксирует неуспешные вызовы.',
        productName: 'Mobile voice',
        service: 'Голосовая связь',
        scenarioName: 'Установление голосового соединения',
        region: 'Москва',
        affectedUsers: 40,
        reportCount: 7,
        growth: 5,
      });
    case 3:
      return add(records, 'MTS-ID-0001', now, {
        correlationKey: 'mts-id-authentication-degradation',
        header: 'Ошибки входа через МТС ID',
        description: 'Часть пользователей не может завершить аутентификацию: запросы к МТС ID завершаются с тайм-аутом.',
        productName: 'МТС ID',
        service: 'Единый вход и авторизация',
        scenarioName: 'Аутентификация пользователя',
        region: 'Россия',
        affectedUsers: 120,
        reportCount: 12,
        growth: 10,
      });
    case 4:
      return add(records, 'MTS-BANK-0001', now, {
        correlationKey: 'mts-bank-payment-confirmation',
        header: 'Ошибки подтверждения операций в МТС Банке',
        description: 'В мобильном банке увеличилось время подтверждения переводов, часть операций требует повторной попытки.',
        productName: 'МТС Банк',
        service: 'Мобильный банк',
        scenarioName: 'Подтверждение финансовой операции',
        region: 'Россия',
        affectedUsers: 650,
        reportCount: 20,
        growth: 20,
        isNeedUp: true,
      });
    case 5:
      return add(records, 'MTS-SMS-0001', now, {
        correlationKey: 'sms-delivery-central-region',
        header: 'Задержка доставки SMS',
        description: 'SMS с кодами подтверждения и сервисными уведомлениями доставляются с задержкой до нескольких минут.',
        productName: 'SMS',
        service: 'Доставка SMS',
        scenarioName: 'Доставка сервисного сообщения',
        region: 'Центральный федеральный округ',
        affectedUsers: 35,
        reportCount: 9,
        growth: 5,
      });
    case 6:
      return add(records, 'MTS-KION-0001', now, {
        correlationKey: 'kion-video-playback-errors',
        header: 'Ошибки воспроизведения видео в KION',
        description: 'Пользователи KION получают ошибку загрузки видеопотока, особенно при начале просмотра в высоком качестве.',
        productName: 'KION',
        service: 'Онлайн-кинотеатр KION',
        scenarioName: 'Воспроизведение видео',
        region: 'Россия',
        affectedUsers: 75,
        reportCount: 11,
        growth: 10,
      });
    case 7:
      return add(records, 'MTS-CLOUD-0001', now, {
        correlationKey: 'mts-cloud-vm-availability',
        header: 'Недоступность виртуальных машин МТС Cloud',
        description: 'Часть виртуальных машин в московском пуле не отвечает. Инженеры проверяют кластер виртуализации и сетевую связность.',
        productName: 'МТС Cloud',
        service: 'Облачные виртуальные машины',
        scenarioName: 'Доступ к виртуальной машине',
        region: 'Москва',
        affectedUsers: 510,
        reportCount: 16,
        growth: 15,
        isMaster: true,
        isEffect: true,
      });
    case 8:
      return add(records, 'MTS-MOBILE-0003', now, {
        correlationKey: null,
        header: 'Жалобы на обрывы голосовой связи в Москве',
        description: 'Абоненты сообщают об обрывах и невозможности установить голосовое соединение. Обращения поступили из нескольких каналов, внешний источник не передал ключ корреляции.',
        productName: 'Mobile voice',
        service: 'Голосовая связь',
        scenarioName: 'Установление голосового соединения',
        region: 'Москва',
        affectedUsers: 15,
        reportCount: 3,
        growth: 5,
      });
    case 9:
      return change(records, 'MTS-BANK-0001', now, (existing) => ({
        stateId: 20,
        solution: 'Включён резервный контур подтверждения операций; первопричина деградации исследуется.',
        reportCount: existing.reportCount + 1,
      }));
    case 10:
      return change(records, 'MTS-KION-0001', now, (existing) => ({
        stateId: 7,
        solution: 'Конфигурация CDN откачена на стабильную версию, воспроизведение видео восстановлено.',
        completionDate: now,
        reportCount: existing.reportCount + 1,
      }));
    case 11:
      return change(records, 'MTS-SMS-0001', now, (existing) => ({
        affectedUsers: Math.max(60, existing.affectedUsers + 5),
        reportCount: existing.reportCount + 2,
      }));
    default:
      throw new Error('Unknown demo scenario');
  }
}

const CONTINUATION_PRODUCTS = [
  {
    code: 'MOBILE',
    correlationKey: 'mobile-voice-regional-outage',
    productName: 'Mobile voice',
    service: 'Голосовая связь',
    scenarioName: 'Установление голосового соединения',
    header: 'Локальная деградация голосовой связи',
    description: 'Мониторинг фиксирует рост неуспешных голосовых вызовов, абоненты сообщают об обрывах соединения.',
    affectedUsers: 25,
    reportCount: 5,
    growth: 40,
    isMaster: true,
    isEffect: true,
  },
  {
    code: 'ID',
    correlationKey: 'mts-id-regional-authentication-errors',
    productName: 'МТС ID',
    service: 'Единый вход и авторизация',
    scenarioName: 'Аутентификация пользователя',
    header: 'Ошибки аутентификации через МТС ID',
    description: 'Часть запросов к МТС ID завершается тайм-аутом, пользователи повторяют попытки входа.',
    affectedUsers: 95,
    reportCount: 8,
    growth: 25,
    isNeedUp: true,
  },
  {
    code: 'BANK',
    correlationKey: 'mts-bank-regional-payment-degradation',
    productName: 'МТС Банк',
    service: 'Мобильный банк',
    scenarioName: 'Подтверждение финансовой операции',
    header: 'Задержки подтверждения операций в МТС Банке',
    description: 'В мобильном банке возросло время подтверждения переводов, часть операций требует повторной попытки.',
    affectedUsers: 620,
    reportCount: 12,
    growth: 30,
  },
  {
    code: 'KION',
    correlationKey: 'kion-regional-playback-errors',
    productName: 'KION',
    service: 'Онлайн-кинотеатр KION',
    scenarioName: 'Воспроизведение видео',
    header: 'Ошибки воспроизведения видео в KION',
    description: 'Пользователи KION получают ошибку загрузки видеопотока при начале просмотра.',
    affectedUsers: 55,
    reportCount: 7,
    growth: 15,
  },
];

const CONTINUATION_STEP_COUNT = CONTINUATION_PRODUCTS.length * 2;

const CONTINUATION_REGIONS = [
  'Санкт-Петербург',
  'Урал',
  'Поволжье',
  'Сибирь',
  'Юг России',
  'Северо-Запад',
  'Дальний Восток',
  'Кавказ',
];

function continuationRegion(seq) {
  return CONTINUATION_REGIONS[seq % CONTINUATION_REGIONS.length];
}

function continuationId(product, seq) {
  return `MTS-${product.code}-${String(100 + seq).padStart(4, '0')}`;
}

function generateCriticalIncident(records, demoStep, continuationIndex, now) {
  const criticalIndex = Math.floor(continuationIndex / CRITICAL_EVERY);
  // Critical steps escalate a real active incident instead of creating a
  // placeholder "demo" card. This keeps the board believable and still
  // produces regular critical escalation every CRITICAL_EVERY steps.
  const candidates = [...records.values()]
    .filter((record) => record.stateId === 0 || record.stateId === 2)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length) {
    const target = candidates[criticalIndex % candidates.length];
    const affectedUsers = Math.max(1000, target.affectedUsers + 500);
    return change(records, target.id, now, {
      affectedUsers,
      reportCount: target.reportCount + 1,
      isNeedUp: true,
      description: `${target.description} Эскалация: число затронутых пользователей выросло до ${affectedUsers}, инцидент переведён в критический контур.`,
    });
  }
  // All records are closed — fall back to a realistic critical record rather
  // than skipping the cadence or reusing the old demo placeholder.
  const region = continuationRegion(demoStep);
  const affectedUsers = 1200 + ((demoStep * 137) % 1801);
  return add(records, `MTS-CRIT-${String(demoStep).padStart(4, '0')}`, now, {
    correlationKey: `critical-fallback-${demoStep}`,
    header: 'Массовый сбой в облачной инфраструктуре МТС',
    description: `Критический инцидент с массовым влиянием. Регион: ${region}.`,
    productName: 'МТС Cloud',
    service: 'Облачные виртуальные машины',
    scenarioName: 'Доступ к виртуальной машине',
    region,
    affectedUsers,
    reportCount: 5,
    growth: 50,
    deadline: new Date(Date.parse(now) + (10 + (demoStep % 6)) * 60 * 1000).toISOString(),
    isNeedUp: true,
    isMaster: true,
    isEffect: true,
  });
}

function generateContinuationIncident(records, continuationIndex, now) {
  const demoStep = SCENARIO_COUNT + continuationIndex;
  if (continuationIndex % CRITICAL_EVERY === 0) {
    return generateCriticalIncident(records, demoStep, continuationIndex, now);
  }
  const cycle = Math.floor(continuationIndex / CONTINUATION_STEP_COUNT);
  const step = continuationIndex % CONTINUATION_STEP_COUNT;
  const productIndex = Math.floor(step / 2);
  const growthStep = step % 2 === 1;
  const product = CONTINUATION_PRODUCTS[productIndex];
  const seq = cycle * CONTINUATION_PRODUCTS.length + productIndex;
  const id = continuationId(product, seq);
  const region = continuationRegion(seq);

  if (growthStep) {
    const existing = records.get(id);
    if (existing) {
      return change(records, id, now, {
        affectedUsers: existing.affectedUsers + product.growth,
        reportCount: existing.reportCount + 1,
        description: `Влияние события расширяется: число затронутых пользователей растёт, новые обращения продолжают поступать. Регион: ${region}.`,
      });
    }
    return add(records, id, now, {
      correlationKey: `${product.correlationKey}-${seq}`,
      header: product.header,
      description: `${product.description} Регион: ${region}.`,
      productName: product.productName,
      service: product.service,
      scenarioName: product.scenarioName,
      region,
      affectedUsers: product.affectedUsers,
      reportCount: product.reportCount,
      growth: product.growth,
      isMaster: product.isMaster,
      isEffect: product.isEffect,
      isNeedUp: product.isNeedUp,
    });
  }

  return add(records, id, now, {
    correlationKey: `${product.correlationKey}-${seq}`,
    header: product.header,
    description: `${product.description} Регион: ${region}.`,
    productName: product.productName,
    service: product.service,
    scenarioName: product.scenarioName,
    region,
    affectedUsers: product.affectedUsers,
    reportCount: product.reportCount,
    growth: product.growth,
    isMaster: product.isMaster,
    isEffect: product.isEffect,
    isNeedUp: product.isNeedUp,
  });
}

export { CRITICAL_EVERY };

export function generateDemoIncident(records, demoStep, now = new Date().toISOString()) {
  if (demoStep < SCENARIO_COUNT) {
    return generateInitialIncident(records, demoStep, now);
  }
  return generateContinuationIncident(records, demoStep - SCENARIO_COUNT, now);
}
