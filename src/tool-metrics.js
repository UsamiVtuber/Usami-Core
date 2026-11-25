/**
 * Métricas de Tool Calling (Observabilidade S4/S5).
 * 
 * Fornece contadores, histogramas e gauges para monitoramento de:
 * - Execução de ferramentas (latência, sucesso/falha, timeout)
 * - Classificação de intenção (determinístico vs LLM, distribuição)
 * - Seleção de ferramentas (Top-K, cache hits)
 * - Permission gate (aprovações, rejeições, níveis)
 * 
 * Uso:
 *   const metrics = createToolMetrics();
 *   metrics.recordToolExecution('calendar.list', 150, true);
 *   metrics.recordIntentClassification('operational', 'llm');
 *   console.log(metrics.getSummary());
 */

export function createToolMetrics({ windowMs = 5 * 60 * 1000, maxSamples = 1000 } = {}) {
  const now = () => Date.now();
  
  // Contadores simples
  const counters = new Map(); // key -> { count, lastUpdated }
  
  // Amostras para histogramas (latência, etc.)
  const samples = new Map(); // key -> [ { value, timestamp }, ... ]
  
  // Gauges (valores atuais)
  const gauges = new Map(); // key -> value
  
  function incrementCounter(key, value = 1) {
    const entry = counters.get(key) || { count: 0, lastUpdated: now() };
    entry.count += value;
    entry.lastUpdated = now();
    counters.set(key, entry);
  }
  
  function recordSample(key, value) {
    const arr = samples.get(key) || [];
    arr.push({ value, timestamp: now() });
    // Limita tamanho e remove amostras antigas
    if (arr.length > maxSamples) arr.shift();
    const cutoff = now() - windowMs;
    while (arr.length > 0 && arr[0].timestamp < cutoff) arr.shift();
    samples.set(key, arr);
  }
  
  function setGauge(key, value) {
    gauges.set(key, value);
  }
  
  function getCounter(key) {
    return counters.get(key)?.count || 0;
  }
  
  function getGauge(key) {
    return gauges.get(key);
  }
  
  function getSamples(key) {
    return samples.get(key) || [];
  }
  
  function percentile(arr, p) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
  
  function summarizeSamples(key) {
    const arr = getSamples(key).map(s => s.value);
    if (arr.length === 0) return { count: 0 };
    const sum = arr.reduce((a, b) => a + b, 0);
    return {
      count: arr.length,
      min: Math.min(...arr),
      max: Math.max(...arr),
      avg: sum / arr.length,
      p50: percentile(arr, 50),
      p95: percentile(arr, 95),
      p99: percentile(arr, 99),
    };
  }
  
  // --- API pública ---
  
  // Tool Execution Metrics
  function recordToolExecution(toolName, latencyMs, success, { timeout = false, permissionLevel = 0 } = {}) {
    const prefix = `tool.${toolName}`;
    incrementCounter(`${prefix}.executions`);
    incrementCounter(`${prefix}.${success ? 'success' : 'error'}`);
    if (timeout) incrementCounter(`${prefix}.timeout`);
    recordSample(`${prefix}.latency`, latencyMs);
    setGauge(`${prefix}.lastLatency`, latencyMs);
    setGauge(`${prefix}.lastStatus`, success ? 'success' : 'error');
    setGauge(`${prefix}.permissionLevel`, permissionLevel);
  }
  
  function recordToolVerification(toolName, passed, latencyMs) {
    const prefix = `tool.${toolName}.verify`;
    incrementCounter(`${prefix}.executions`);
    incrementCounter(`${prefix}.${passed ? 'passed' : 'failed'}`);
    recordSample(`${prefix}.latency`, latencyMs);
  }
  
  // Intent Classification Metrics
  function recordIntentClassification(kind, origin) {
    // kind: 'conversation' | 'operational' | 'complex'
    // origin: 'classifier' | 'llm'
    incrementCounter(`intent.${kind}.total`);
    incrementCounter(`intent.${kind}.${origin}`);
    incrementCounter(`intent.origin.${origin}`);
  }
  
  // Tool Selection Metrics
  function recordToolSelection(query, selectedCount, totalAvailable, cacheHit) {
    incrementCounter('toolSelection.queries');
    incrementCounter(`toolSelection.cache.${cacheHit ? 'hit' : 'miss'}`);
    recordSample('toolSelection.selectedCount', selectedCount);
    recordSample('toolSelection.totalAvailable', totalAvailable);
    setGauge('toolSelection.lastSelectedCount', selectedCount);
  }
  
  // Permission Gate Metrics
  function recordPermissionGate(toolName, level, granted, { requiredConfirmation = false } = {}) {
    const prefix = `permission.${toolName}`;
    incrementCounter(`${prefix}.checks`);
    incrementCounter(`${prefix}.level${level}`);
    incrementCounter(`${prefix}.${granted ? 'granted' : 'denied'}`);
    if (requiredConfirmation) incrementCounter(`${prefix}.confirmationRequired`);
    setGauge(`${prefix}.lastLevel`, level);
    setGauge(`${prefix}.lastGranted`, granted);
  }
  
  // LLM Tool Calling Metrics (generateReplyWithTools)
  function recordLlmToolCall(toolName, iterations, totalLatencyMs, success) {
    const prefix = `llmTool.${toolName}`;
    incrementCounter(`${prefix}.calls`);
    incrementCounter(`${prefix}.${success ? 'success' : 'error'}`);
    recordSample(`${prefix}.iterations`, iterations);
    recordSample(`${prefix}.totalLatency`, totalLatencyMs);
    setGauge(`${prefix}.lastIterations`, iterations);
  }
  
  function recordLlmToolChain(chainLength, totalLatencyMs, success) {
    incrementCounter('llmToolChain.chains');
    incrementCounter(`llmToolChain.${success ? 'success' : 'error'}`);
    recordSample('llmToolChain.length', chainLength);
    recordSample('llmToolChain.totalLatency', totalLatencyMs);
    setGauge('llmToolChain.lastLength', chainLength);
  }
  
  // Summary & Export
  function getSummary() {
    const toolNames = new Set();
    for (const key of counters.keys()) {
      const match = key.match(/^tool\.(.+)\.(executions|success|error|timeout|latency|verify|lastLatency|lastStatus|permissionLevel)$/);
      if (match) toolNames.add(match[1]);
    }
    
    const tools = {};
    for (const name of toolNames) {
      tools[name] = {
        executions: getCounter(`tool.${name}.executions`),
        success: getCounter(`tool.${name}.success`),
        error: getCounter(`tool.${name}.error`),
        timeout: getCounter(`tool.${name}.timeout`),
        latency: summarizeSamples(`tool.${name}.latency`),
        verify: {
          executions: getCounter(`tool.${name}.verify.executions`),
          passed: getCounter(`tool.${name}.verify.passed`),
          failed: getCounter(`tool.${name}.verify.failed`),
          latency: summarizeSamples(`tool.${name}.verify.latency`),
        },
        lastLatency: getGauge(`tool.${name}.lastLatency`),
        lastStatus: getGauge(`tool.${name}.lastStatus`),
        permissionLevel: getGauge(`tool.${name}.permissionLevel`),
      };
    }
    
    const intentKinds = ['conversation', 'operational', 'complex'];
    const intent = {};
    for (const kind of intentKinds) {
      intent[kind] = {
        total: getCounter(`intent.${kind}.total`),
        classifier: getCounter(`intent.${kind}.classifier`),
        llm: getCounter(`intent.${kind}.llm`),
      };
    }
    intent.origin = {
      classifier: getCounter('intent.origin.classifier'),
      llm: getCounter('intent.origin.llm'),
    };
    
    const toolSelection = {
      queries: getCounter('toolSelection.queries'),
      cacheHits: getCounter('toolSelection.cache.hit'),
      cacheMisses: getCounter('toolSelection.cache.miss'),
      selectedCount: summarizeSamples('toolSelection.selectedCount'),
      totalAvailable: summarizeSamples('toolSelection.totalAvailable'),
    };
    
    const permission = {};
    for (const key of counters.keys()) {
      const match = key.match(/^permission\.(.+)\.(checks|granted|denied|confirmationRequired|level\d+|lastLevel|lastGranted)$/);
      if (match) permission[match[1]] = true;
    }
    const permissionTools = Object.keys(permission);
    const permissionSummary = {};
    for (const name of permissionTools) {
      permissionSummary[name] = {
        checks: getCounter(`permission.${name}.checks`),
        granted: getCounter(`permission.${name}.granted`),
        denied: getCounter(`permission.${name}.denied`),
        confirmationRequired: getCounter(`permission.${name}.confirmationRequired`),
        lastLevel: getGauge(`permission.${name}.lastLevel`),
        lastGranted: getGauge(`permission.${name}.lastGranted`),
      };
    }
    
    const llmTool = {};
    for (const key of counters.keys()) {
      const match = key.match(/^llmTool\.([^.]+)\./);
      if (match) llmTool[match[1]] = true;
    }
    const llmToolNames = Object.keys(llmTool);
    const llmToolSummary = {};
    for (const name of llmToolNames) {
      llmToolSummary[name] = {
        calls: getCounter(`llmTool.${name}.calls`),
        success: getCounter(`llmTool.${name}.success`),
        error: getCounter(`llmTool.${name}.error`),
        iterations: summarizeSamples(`llmTool.${name}.iterations`),
        totalLatency: summarizeSamples(`llmTool.${name}.totalLatency`),
        lastIterations: getGauge(`llmTool.${name}.lastIterations`),
      };
    }
    
    return {
      timestamp: now(),
      tools,
      intent,
      toolSelection,
      permission: permissionSummary,
      llmTool: llmToolSummary,
      llmToolChain: {
        chains: getCounter('llmToolChain.chains'),
        success: getCounter('llmToolChain.success'),
        error: getCounter('llmToolChain.error'),
        length: summarizeSamples('llmToolChain.length'),
        totalLatency: summarizeSamples('llmToolChain.totalLatency'),
        lastLength: getGauge('llmToolChain.lastLength'),
      },
    };
  }
  
  function reset() {
    counters.clear();
    samples.clear();
    gauges.clear();
  }
  
  // Export para Prometheus/JSON
  function toPrometheus() {
    const lines = [];
    const summary = getSummary();
    
    // Tools
    for (const [name, data] of Object.entries(summary.tools)) {
      const safeName = name.replace(/\./g, '_');
      lines.push(`# TYPE usami_tool_executions_total counter`);
      lines.push(`usami_tool_executions_total{tool="${name}"} ${data.executions}`);
      lines.push(`usami_tool_success_total{tool="${name}"} ${data.success}`);
      lines.push(`usami_tool_error_total{tool="${name}"} ${data.error}`);
      lines.push(`usami_tool_timeout_total{tool="${name}"} ${data.timeout}`);
      if (data.latency.count > 0) {
        lines.push(`# TYPE usami_tool_latency_ms summary`);
        lines.push(`usami_tool_latency_ms_sum{tool="${name}"} ${data.latency.avg * data.latency.count}`);
        lines.push(`usami_tool_latency_ms_count{tool="${name}"} ${data.latency.count}`);
      }
    }
    
    // Intent
    for (const [kind, data] of Object.entries(summary.intent)) {
      if (kind === 'origin') continue;
      lines.push(`# TYPE usami_intent_total counter`);
      lines.push(`usami_intent_total{kind="${kind}",origin="classifier"} ${data.classifier}`);
      lines.push(`usami_intent_total{kind="${kind}",origin="llm"} ${data.llm}`);
    }
    
    return lines.join('\n') + '\n';
  }
  
  return {
    // Recording
    recordToolExecution,
    recordToolVerification,
    recordIntentClassification,
    recordToolSelection,
    recordPermissionGate,
    recordLlmToolCall,
    recordLlmToolChain,
    // Query
    getSummary,
    getCounter,
    getGauge,
    getSamples,
    summarizeSamples,
    // Maintenance
    reset,
    // Export
    toPrometheus,
    toJson: getSummary,
  };
}

// Instância global singleton (opcional)
let globalMetrics = null;

export function getGlobalToolMetrics(options) {
  if (!globalMetrics) {
    globalMetrics = createToolMetrics(options);
  }
  return globalMetrics;
}

export function setGlobalToolMetrics(metrics) {
  globalMetrics = metrics;
}