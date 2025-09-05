// Configuración global para Google Flights Scraper
export const CONFIG = {
  // URLs
  GOOGLE_FLIGHTS_URL: 'https://www.google.com/travel/flights?hl=es-419&gl=MX',
  
  // Configuración de región y localización
  LOCALE: {
    language: 'es-419',  // Spanish (Latin America)
    country: 'MX',       // Mexico
    timezone: 'America/Mexico_City',
    currency: 'MXN'
  },
  
  // Geolocalización (Ciudad de México)
  GEOLOCATION: {
    latitude: 19.4326,
    longitude: -99.1332
  },
  
  // Configuración del navegador
  BROWSER: {
    headless: false,      // true = sin mostrar navegador, false = mostrar navegador
    viewport: {
      width: 1280,
      height: 800
    },
    timeout: {
      navigation: 30000,   // 30 segundos para navegación
      element: 10000,      // 10 segundos para elementos
      search: 20000        // 20 segundos para búsqueda
    },
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--disable-extensions'
    ]
  },
  
  // User Agents reales para evitar detección
  USER_AGENTS: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ],
  
  // Selectores para elementos de la página
  SELECTORS: {
    // Configuración de viaje
    TRIP_TYPE_DROPDOWN: '.VfPpkd-aPP78e',
    ONE_WAY_OPTION: 'role=option[name*="Solo ida" i]',
    
    // Campos de búsqueda
    ORIGIN_FIELD: 'role=combobox[name*="desde" i]',
    DESTINATION_FIELD: 'role=combobox[name*="dónde quieres" i]',
    DATE_FIELD: 'role=textbox[name*="salida" i]',
    
    // Botones
    SEARCH_BUTTON: 'role=button[name*="buscar" i]',
    DONE_BUTTON: 'role=button[name*="listo" i]',
    
    // Precios
    PRICE_ELEMENTS: [
      '[jsname="qCDwBb"]',
      'div.CylAxb[jsname="qCDwBb"]',
      '.pIav2d',
      '.YMlIz'
    ]
  },
  
  // Configuración de búsqueda
  SEARCH: {
    MAX_PRICE_SEARCH_ATTEMPTS: 15,
    PRICE_SEARCH_INTERVAL: 3000,  // 3 segundos entre intentos
    MAX_CALENDAR_NAVIGATION_ATTEMPTS: 15,
    CALENDAR_NAVIGATION_INTERVAL: 500,  // 0.5 segundos entre clicks de mes
    CLICK_DELAY: 1500  // 1.5 segundos entre clicks
  },
  
  // Configuración de Supabase (se toma de variables de entorno)
  SUPABASE: {
    URL: process.env.SUPABASE_URL,
    KEY: process.env.SUPABASE_KEY
  },
  
  // Configuración de alertas
  ALERTS: {
    PUSHCUT_URL: 'https://api.pushcut.io/eOU0kCDr2y95dXanO0nwk/notifications/Google%20Flights',
    PRICE_DROP_THRESHOLD: 400,  // MXN - mínimo de bajada para alertar
    TREND_CHANGE_THRESHOLD: 50  // MXN - mínimo para alerta de cambio de tendencia
  },
  
  // Configuración de archivos y logging
  FILES: {
    SCREENSHOTS_DIR: './screenshots',
    LOGS_DIR: './logs',
    ERROR_LOGS_DIR: './error_logs',
    HTML_DUMPS_DIR: './html_dumps'
  },
  
  // Headers HTTP para las peticiones
  HTTP_HEADERS: {
    'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  }
};

// Función para obtener un User Agent aleatorio
export function getRandomUserAgent() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

// Función para obtener configuración del navegador con User Agent aleatorio
export function getBrowserConfig() {
  return {
    headless: CONFIG.BROWSER.headless,
    args: CONFIG.BROWSER.args,
    defaultViewport: null
  };
}

// Función para obtener configuración de contexto
export function getContextConfig() {
  return {
    viewport: CONFIG.BROWSER.viewport,
    locale: CONFIG.LOCALE.language,
    geolocation: CONFIG.GEOLOCATION,
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      ...CONFIG.HTTP_HEADERS,
      'User-Agent': getRandomUserAgent()
    }
  };
}

// Función para validar configuración
export function validateConfig() {
  const errors = [];
  
  if (!CONFIG.SUPABASE.URL) {
    errors.push('SUPABASE_URL no está definida en variables de entorno');
  }
  
  if (!CONFIG.SUPABASE.KEY) {
    errors.push('SUPABASE_KEY no está definida en variables de entorno');
  }
  
  if (errors.length > 0) {
    console.error('❌ Errores de configuración:');
    errors.forEach(error => console.error(`   - ${error}`));
    return false;
  }
  
  return true;
}

export default CONFIG;