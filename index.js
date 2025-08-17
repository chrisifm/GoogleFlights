import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';

// Configuración de Supabase - usando variables de entorno
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Configuración del modo navegador
const isHeadless = true; // true = ejecutar en consola sin mostrar navegador, false = mostrar navegador

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Error: SUPABASE_URL y SUPABASE_KEY son requeridas como variables de entorno');
    console.error('   Crea un archivo .env con estas variables o configúralas en tu sistema');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Función para registrar errores en tabla errors
async function logError(errorData) {
    try {
        const errorPayload = {
            error_type: errorData.error_type || 'Unknown',
            error_message: errorData.error_message || 'No message provided',
            route_from: errorData.from || 'Unknown',
            route_to: errorData.to || 'Unknown',
            flight_date: errorData.flight_date || null,
            selector_attempted: errorData.selector_used || null,
            page_url: errorData.url || 'Unknown',
            html_content: errorData.content_html || null,
            user_agent: errorData.user_agent || 'Unknown',
            viewport_size: errorData.viewport || null,
            error_details: {
                log_details: errorData.log_details || '',
                stack_trace: errorData.stack_trace || null,
                price_found: errorData.price_found || false,
                network_status: errorData.network_status || 'Unknown',
                page_title: errorData.page_title || null
            },
            session_id: errorData.session_id || null,
            retry_count: errorData.retry_count || 0
        };

        // Intentar insertar en Supabase
        const { data, error } = await supabase
            .from('errors_log')
            .insert([errorPayload]);

        if (error) {
            console.error('❌ Error al insertar log de error en Supabase:', error.message);
            // Si falla Supabase, al menos loggear en consola
            console.error('📋 Error que no se pudo guardar:', JSON.stringify(errorPayload, null, 2));
        } else {
            console.log('✅ Error registrado en tabla errors_log');
        }
    } catch (err) {
        console.error('❌ Error crítico al intentar loggear error:', err.message);
        console.error('📋 Datos del error original:', JSON.stringify(errorData, null, 2));
    }
}

// Verificar conexión a Supabase
async function testSupabaseConnection() {
    try {
        const { data, error } = await supabase
            .from('flights')
            .select('count', { count: 'exact', head: true });
        
        if (error) {
            console.error('❌ Error al conectar con Supabase:', error.message);
            
            // Log error sin esperar (para no bloquear)
            logError({
                error_type: 'SUPABASE_CONNECTION',
                error_message: error.message,
                log_details: `Error al conectar con Supabase tabla flights: ${JSON.stringify(error, null, 2)}`,
                stack_trace: error.stack || null,
                network_status: 'Failed',
                from: 'Connection Test',
                to: 'Supabase'
            }).catch(() => {}); // Evitar error recursivo
            
            return false;
        }
        
        console.log('✅ Conexión exitosa con Supabase');
        console.log(`📊 Total de registros en tabla flights: ${data || 0}`);
        return true;
    } catch (error) {
        console.error('❌ Error de conexión con Supabase:', error.message);
        
        // Log error crítico de conexión
        logError({
            error_type: 'SUPABASE_CRITICAL_ERROR',
            error_message: error.message,
            log_details: `Error crítico de conexión: ${error.message}\nStack: ${error.stack}`,
            stack_trace: error.stack || null,
            network_status: 'Critical Failure',
            from: 'Connection Test',
            to: 'Supabase'
        }).catch(() => {}); // Evitar error recursivo
        
        return false;
    }
}

// Función para parsear precio y extraer currency
function parsePrice(priceString) {
    // Ejemplo: "MX$2,546" -> { currency: "MX", price: 2546 }
    const match = priceString.match(/([A-Z]{1,3})\$?([\d,]+)/);
    
    if (match) {
        const currency = match[1]; // MX, US, R, etc.
        const numericPrice = parseFloat(match[2].replace(/,/g, '')); // Remover comas y convertir a número
        return { currency, price: numericPrice };
    }
    
    // Fallback si no se puede parsear
    return { currency: 'USD', price: 0 };
}

// Función para enviar alerta de precio bajo
async function sendPriceAlert(from, to, currentPrice, currency, flightDate, reason = 'Precio bajo detectado') {
    try {
        const response = await fetch('https://api.pushcut.io/eOU0kCDr2y95dXanO0nwk/notifications/Google%20Flights', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: `${reason}: ${currency}$${currentPrice} para ${flightDate}`,
                title: `Vuelo ${from} → ${to}`
            })
        });

        if (response.ok) {
            console.log('🚨 Alerta de precio enviada exitosamente');
        } else {
            console.error('Error al enviar alerta:', response.statusText);
        }
    } catch (error) {
        console.error('Error al enviar alerta:', error);
    }
}

// Función para detectar tendencias de precio y enviar alertas inteligentes
async function checkPriceTrendAndAlert(from, to, currentPrice, currency, currentLink, flightDate) {
    try {
        // Obtener historial de precios ordenado por fecha (más reciente primero)
        const { data: flights, error } = await supabase
            .from('flights')
            .select('price, currency, link, flight_date, updated_at')
            .eq('from', from)
            .eq('to', to)
            .eq('link', currentLink)
            .eq('flight_date', flightDate)
            .order('updated_at', { ascending: false });

        if (error) {
            console.error('Error al consultar precios históricos:', error);
            
            // Log error de consulta de tendencias
            await logError({
                error_type: 'SUPABASE_QUERY_ERROR',
                error_message: error.message,
                log_details: `Error al consultar historial de precios para tendencias: ${JSON.stringify(error, null, 2)}`,
                url: currentLink,
                from: from,
                to: to,
                flight_date: flightDate,
                stack_trace: error.stack || null
            });
            
            return false;
        }

        console.log(`📊 Encontrados ${flights.length} registros históricos para ${from} -> ${to} (${flightDate})`);
        
        if (flights.length === 0) {
            console.log('📈 Primer registro para esta fecha/ruta - no hay comparación histórica');
            return false;
        }

        const lastPrice = flights[0].price; // Precio más reciente
        const priceHistory = flights.map(f => f.price);
        const lowestPrice = Math.min(...priceHistory);
        const highestPrice = Math.max(...priceHistory);
        
        console.log(`💰 Precio actual: ${currency}$${currentPrice}`);
        console.log(`📊 Último precio registrado: ${currency}$${lastPrice}`);
        console.log(`📉 Precio más bajo histórico: ${currency}$${lowestPrice}`);
        console.log(`📈 Precio más alto histórico: ${currency}$${highestPrice}`);
        
        // Calcular diferencias
        const priceDifference = lastPrice - currentPrice;
        const isSignificantDrop = priceDifference >= 100; // Al menos $100 MX de bajada
        const isNewLowest = currentPrice < lowestPrice;
        
        console.log(`📉 Diferencia vs último precio: $${priceDifference} MX`);
        console.log(`🎯 Bajada significativa (+$100): ${isSignificantDrop ? 'SÍ' : 'NO'}`);
        console.log(`🏆 Nuevo precio más bajo: ${isNewLowest ? 'SÍ' : 'NO'}`);
        
        // Detectar tendencia (últimos 3 precios si hay suficientes)
        let trendChange = false;
        if (flights.length >= 3) {
            const last3Prices = priceHistory.slice(0, 3);
            const wasIncreasing = last3Prices[2] < last3Prices[1] && last3Prices[1] < last3Prices[0];
            const nowDecreasing = currentPrice < lastPrice;
            
            trendChange = wasIncreasing && nowDecreasing;
            console.log(`📈📉 Cambio de tendencia (subía -> baja): ${trendChange ? 'SÍ' : 'NO'}`);
        }
        
        // Determinar si enviar alerta
        let shouldAlert = false;
        let alertReason = '';
        
        if (isNewLowest) {
            shouldAlert = true;
            alertReason = 'Nuevo precio más bajo histórico';
        } else if (isSignificantDrop) {
            shouldAlert = true;
            alertReason = `Bajada significativa de $${priceDifference} MX`;
        } else if (trendChange && priceDifference >= 50) {
            shouldAlert = true;
            alertReason = `Cambio de tendencia: bajó $${priceDifference} MX`;
        }
        
        if (shouldAlert) {
            console.log(`🚨 ENVIANDO ALERTA: ${alertReason}`);
            await sendPriceAlert(from, to, currentPrice, currency, flightDate, alertReason);
            return true;
        } else {
            console.log('📝 No se cumplen condiciones para alerta');
            console.log('   Condiciones requeridas:');
            console.log('   - Nuevo precio más bajo histórico, O');
            console.log('   - Bajada de al menos $100 MX, O');
            console.log('   - Cambio de tendencia con bajada de al menos $50 MX');
            return false;
        }
        
    } catch (error) {
        console.error('Error al verificar tendencia de precios:', error);
        return false;
    }
}

// Función para verificar si el registro ya existe
async function checkDuplicateRecord(from, to, price, link, flightDate) {
    try {
        const { data: existingFlights, error } = await supabase
            .from('flights')
            .select('id, price, from, to, link, flight_date')
            .eq('from', from)
            .eq('to', to)
            .eq('price', price)
            .eq('link', link)
            .eq('flight_date', flightDate);

        if (error) {
            console.error('Error al verificar duplicados:', error);
            
            // Log error de verificación de duplicados
            await logError({
                error_type: 'SUPABASE_DUPLICATE_CHECK_ERROR',
                error_message: error.message,
                log_details: `Error al verificar duplicados: ${JSON.stringify(error, null, 2)}`,
                url: link,
                from: from,
                to: to,
                flight_date: flightDate,
                price_found: true,
                stack_trace: error.stack || null
            });
            
            return false;
        }

        return existingFlights.length > 0;
    } catch (error) {
        console.error('Error al verificar duplicados:', error);
        
        // Log error crítico de duplicados
        await logError({
            error_type: 'SUPABASE_DUPLICATE_CHECK_CRITICAL',
            error_message: error.message,
            log_details: `Error crítico al verificar duplicados: ${error.message}`,
            url: link,
            from: from,
            to: to,
            flight_date: flightDate,
            stack_trace: error.stack || null
        });
        
        return false;
    }
}

// Función para insertar vuelo en Supabase
async function insertFlight(from, to, priceString, link, flightDate = null) {
    try {
        const { currency, price } = parsePrice(priceString);
        
        // SIEMPRE verificar tendencias de precio, incluso si es duplicado
        console.log('🔍 Analizando tendencias de precio...');
        await checkPriceTrendAndAlert(from, to, price, currency, link, flightDate);
        
        // Verificar si ya existe un registro exactamente igual
        const isDuplicate = await checkDuplicateRecord(from, to, price, link, flightDate);
        
        if (isDuplicate) {
            console.log('⚠️  Registro duplicado encontrado. No se insertará nuevamente.');
            console.log(`   From: ${from}, To: ${to}, Price: ${currency}$${price}, Date: ${flightDate}, Link: ${link.substring(0, 50)}...`);
            console.log('📝 Ya existe un registro igual en la base de datos');
            console.log('✅ Análisis de tendencias completado - no es necesario insertar duplicado');
            return false;
        }
        
        const payload = {
            updated_at: new Date().toISOString(),
            from: from,
            to: to,
            price: price,
            currency: currency,
            link: link,
            flight_date: flightDate
        };

        // Mostrar payload antes de insertar
        console.log('📦 Payload a insertar en Supabase:');
        console.log(JSON.stringify(payload, null, 2));

        const { data, error } = await supabase
            .from('flights')
            .insert([payload]);

        if (error) {
            console.error('Error al insertar en Supabase:', error);
            
            // Log error de inserción
            await logError({
                error_type: 'SUPABASE_INSERT_ERROR',
                error_message: error.message,
                log_details: `Error al insertar vuelo: ${JSON.stringify(error, null, 2)}\nPayload: ${JSON.stringify(payload, null, 2)}`,
                url: link,
                from: from,
                to: to,
                flight_date: flightDate,
                price_found: true,
                stack_trace: error.stack || null
            });
            
            return false;
        }

        console.log('✅ Vuelo insertado exitosamente en Supabase');
        
        return true;
    } catch (error) {
        console.error('Error de conexión con Supabase:', error);
        
        // Log error crítico de inserción
        await logError({
            error_type: 'FLIGHT_INSERT_CRITICAL_ERROR',
            error_message: error.message,
            log_details: `Error crítico al procesar inserción de vuelo: ${error.message}\nString precio: ${priceString}`,
            url: link,
            from: from,
            to: to,
            flight_date: flightDate,
            stack_trace: error.stack || null
        });
        
        return false;
    }
}

// Configuración para Brasil
const BRAZIL_CONFIG = {
  // Geolocalización para Florianópolis, Brasil
  latitude: -27.5954,
  longitude: -48.5480,
  
  // Timezone de Brasil
  timezone: 'America/Sao_Paulo',
  
  // Configuración de idioma y región
  locale: 'pt-BR',
  
  // URLs de Google Flights a comprobar - COMENTADAS (destinos anteriores)
  urls: [
    // Destinos anteriores comentados
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTA2ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTI3ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTE2ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTIzahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTMwahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTA2ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTMwahEIAhIKL20vMDljdjJiahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTA2ahEIAhIKL20vMDljdjJiahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // 'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTEzahEIAhIKL20vMDljdjJiahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN'
    
    // Nuevos destinos - Viernes 29 agosto 2025
    // Florianópolis -> GIG (Rio de Janeiro - Galeão)
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTI5ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA0dJR0ABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    // Florianópolis -> RIO (todos los aeropuertos de Rio de Janeiro, incluye Santos Dumont)
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTI5ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA1JJT0ABSAFwAYIBCwj___________8BmAEC&curr=MXN'
  ],
  
  // Viewport máximo
  viewport: {
    width: 980,
    height: 800
  }
};

// User agents reales para simular navegadores genuinos
const REAL_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

const crawler = new PlaywrightCrawler({
    async requestHandler({ request, page, enqueueLinks, pushData }) {
        console.log(`\n🌐 Procesando URL: ${request.loadedUrl}`);
        console.log('='.repeat(80));
        
        // Configurar User Agent al inicio para que esté disponible en todo el scope
        const randomUserAgent = REAL_USER_AGENTS[Math.floor(Math.random() * REAL_USER_AGENTS.length)];
        
        // Verificar conexión a Supabase para cada URL
        console.log('🔗 Verificando conexión a Supabase...');
        const isConnected = await testSupabaseConnection();
        
        if (!isConnected) {
            console.error('❌ No se pudo conectar a Supabase para esta URL.');
            
            // Log error de conexión con contexto de URL
            await logError({
                error_type: 'SUPABASE_CONNECTION_URL',
                error_message: 'No se pudo conectar a Supabase para procesar URL',
                log_details: `URL siendo procesada: ${request.loadedUrl}`,
                url: request.loadedUrl,
                network_status: 'Connection Failed'
            });
            
            return; // Continuar con la siguiente URL en lugar de terminar
        }
        
        console.log('Configurando navegador con configuración de Brasil...');
        
        // Configurar viewport
        await page.setViewportSize(BRAZIL_CONFIG.viewport);
        
        // Configurar headers realistas para evitar detección (ya declarado arriba)
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': `${BRAZIL_CONFIG.locale},pt;q=0.9,en;q=0.8`,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': randomUserAgent
        });
        
        // Configurar geolocalización para Florianópolis
        await page.context().setGeolocation({
            latitude: BRAZIL_CONFIG.latitude,
            longitude: BRAZIL_CONFIG.longitude
        });
        
        // Script anti-detección y configuración de timezone
        await page.context().addInitScript(() => {
            // Override timezone
            Object.defineProperty(Intl, 'DateTimeFormat', {
                value: function(...args) {
                    if (args.length === 0 || (args.length === 1 && typeof args[0] === 'object' && args[0].timeZone === undefined)) {
                        args[0] = { ...args[0], timeZone: 'America/Sao_Paulo' };
                    }
                    return new Intl.DateTimeFormat(...args);
                }
            });
            
            // Ocultar propiedades de webdriver
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            
            // Sobrescribir plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            
            // Ocultar automation
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            
            // Chrome runtime
            window.chrome = {
                runtime: {}
            };
            
            // Permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });
        
        console.log(`Configuración aplicada:`);
        console.log(`- Geolocalización: Florianópolis (${BRAZIL_CONFIG.latitude}, ${BRAZIL_CONFIG.longitude})`);
        console.log(`- Timezone: ${BRAZIL_CONFIG.timezone}`);
        console.log(`- Locale: ${BRAZIL_CONFIG.locale}`);
        console.log(`- Viewport: ${BRAZIL_CONFIG.viewport.width}x${BRAZIL_CONFIG.viewport.height}`);
        console.log(`- User Agent: ${randomUserAgent}`);
        console.log(`- URL: ${request.loadedUrl}`);
        
        const title = await page.title();
        console.log(`Título de la página: ${title}`);
        
        // Esperar a que cargue la tabla de vuelos
        console.log('Esperando a que cargue la tabla de vuelos...');
        await page.waitForTimeout(5000);
        
        // Extraer información del vuelo y precio
        let flightPrice = 'No encontrado';
        let fromCity = 'Unknown';
        let toCity = 'Unknown';
        let flightDate = 'No encontrado';
        let extractionErrors = [];
        let successfulSelector = null;
        
        try {
            // Extraer origen y destino desde el título
            const titleParts = title.split(' to ');
            if (titleParts.length >= 2) {
                fromCity = titleParts[0].trim();
                toCity = titleParts[1].split(' |')[0].trim();
                console.log(`🛫 Origen: ${fromCity} | Destino: ${toCity}`);
            } else {
                extractionErrors.push('No se pudo extraer origen/destino del título');
                console.log('⚠️  No se pudo extraer origen/destino del título');
            }
            
            // Extraer fecha del campo de filtros
            const dateSelectors = [
                'input.TP4Lpb.eoY5cb.j0Ppje[aria-label="Departure"]',
                'input[placeholder="Departure"]',
                'input.TP4Lpb',
                '[jsname="yrriRe"]'
            ];
            
            let dateFound = false;
            for (const dateSelector of dateSelectors) {
                try {
                    const dateValue = await page.$eval(dateSelector, el => el.value || el.textContent);
                    if (dateValue && dateValue.trim() && dateValue !== 'Departure') {
                        flightDate = dateValue.trim();
                        console.log(`📅 Fecha extraída: ${flightDate}`);
                        dateFound = true;
                        break;
                    }
                } catch (e) {
                    // Continuar con el siguiente selector
                }
            }
            
            if (!dateFound) {
                extractionErrors.push('No se pudo extraer la fecha con ningún selector');
                console.log('⚠️  No se pudo extraer la fecha del vuelo');
            }
            
            // Buscar precio usando múltiples selectores más robustos
            const priceSelectors = [
                '.pIav2d',
                '[data-test-id*="price"]',
                '.price',
                'span[aria-label*="price"]',
                '.result-price',
                '[class*="price"]',
                '.BpkText_bpk-text__Y2I3Y',
                '.google-flights-price',
                '[jsname="qCDwBb"]',
                '[jsname="b1c5Je"]'
            ];
            
            let priceElement = null;
            let successfulSelector = null;
            let failedSelectors = [];
            
            for (const selector of priceSelectors) {
                try {
                    priceElement = await page.$eval(selector, element => {
                        const text = element.textContent;
                        const priceMatch = text.match(/MX\$[\d,]+/);
                        return priceMatch ? priceMatch[0] : null;
                    });
                    
                    if (priceElement) {
                        console.log(`💰 Precio encontrado con selector: ${selector}`);
                        successfulSelector = selector;
                        break;
                    } else {
                        failedSelectors.push(`${selector} (sin match MX$)`);
                    }
                } catch (e) {
                    failedSelectors.push(`${selector} (error: ${e.message})`);
                }
            }
            
            // Si no encuentra con selectores específicos, buscar en todo el DOM
            if (!priceElement) {
                try {
                    priceElement = await page.evaluate(() => {
                        const allElements = document.querySelectorAll('*');
                        for (const element of allElements) {
                            const text = element.textContent;
                            if (text && text.includes('MX$')) {
                                const priceMatch = text.match(/MX\$[\d,]+/);
                                if (priceMatch) {
                                    return priceMatch[0];
                                }
                            }
                        }
                        return null;
                    });
                    
                    if (priceElement) {
                        console.log(`💰 Precio encontrado en búsqueda general del DOM`);
                        successfulSelector = 'DOM_GENERAL_SEARCH';
                    }
                } catch (e) {
                    console.log('Error en búsqueda general del DOM:', e.message);
                    extractionErrors.push(`Error en búsqueda DOM: ${e.message}`);
                }
            }
            
            if (priceElement) {
                flightPrice = priceElement;
            } else {
                extractionErrors.push(`No se encontró precio con ningún selector. Selectores fallidos: ${failedSelectors.join(', ')}`);
            }
            
        } catch (error) {
            console.log('Error al extraer información del vuelo:', error.message);
            extractionErrors.push(`Error general en extracción: ${error.message}`);
        }
        
        // Imprimir solo el precio
        console.log(flightPrice);
        
        // Loggear errores si hubo problemas en la extracción
        if (extractionErrors.length > 0 || flightPrice === 'No encontrado') {
            try {
                // Obtener HTML relevante para debugging
                const relevantHTML = await page.evaluate(() => {
                    // Capturar estructura general y elementos que podrían contener precios
                    const priceElements = document.querySelectorAll('*');
                    let htmlStructure = `<title>${document.title}</title>\n`;
                    
                    // Buscar elementos que podrían contener precios
                    const potentialPriceElements = [];
                    for (const el of priceElements) {
                        const text = el.textContent;
                        if (text && (text.includes('MX$') || text.includes('$') || text.includes('price') || text.includes('Price'))) {
                            potentialPriceElements.push({
                                tag: el.tagName,
                                className: el.className,
                                id: el.id,
                                text: text.substring(0, 100), // Limitar texto
                                innerHTML: el.innerHTML.substring(0, 200) // Limitar HTML
                            });
                        }
                    }
                    
                    htmlStructure += `\n<!-- Elementos con potencial de precio -->\n`;
                    htmlStructure += JSON.stringify(potentialPriceElements, null, 2);
                    
                    return htmlStructure.substring(0, 10000); // Limitar a 10KB para la DB
                });
                
                await logError({
                    error_type: flightPrice === 'No encontrado' ? 'PRICE_NOT_FOUND' : 'EXTRACTION_WARNING',
                    error_message: flightPrice === 'No encontrado' ? 'No se pudo extraer el precio' : 'Errores en extracción de datos',
                    log_details: `Errores: ${extractionErrors.join('; ')}`,
                    url: request.loadedUrl,
                    from: fromCity,
                    to: toCity,
                    flight_date: flightDate,
                    price_found: flightPrice !== 'No encontrado',
                    selector_used: successfulSelector,
                    page_title: title,
                    user_agent: randomUserAgent,
                    viewport: `${BRAZIL_CONFIG.viewport.width}x${BRAZIL_CONFIG.viewport.height}`,
                    content_html: relevantHTML
                });
                
            } catch (htmlError) {
                console.error('Error al capturar HTML para logging:', htmlError.message);
            }
        }
        
        // Insertar en Supabase si se encontró el precio
        if (flightPrice !== 'No encontrado') {
            await insertFlight(fromCity, toCity, flightPrice, request.loadedUrl, flightDate);
        }
        
        await pushData({ 
            title, 
            url: request.loadedUrl,
            timestamp: new Date().toLocaleString('pt-BR', { timeZone: BRAZIL_CONFIG.timezone }),
            location: 'Florianópolis, Brasil',
            userAgent: randomUserAgent,
            viewport: BRAZIL_CONFIG.viewport,
            flightPrice: flightPrice,
            fromCity: fromCity,
            toCity: toCity,
            flightDate: flightDate
        });
        
        // Marcar como completada esta URL
        console.log('✅ Extracción completada para esta URL.');
        console.log('='.repeat(80));
    },
    maxRequestsPerCrawl: BRAZIL_CONFIG.urls.length,
    headless: isHeadless, // Controlado por variable isHeadless
    launchContext: {
        launchOptions: {
            args: [
                '--no-sandbox',
                '--disable-web-security',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=VizDisplayCompositor',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-infobars',
                '--disable-extensions-file-access-check',
                '--disable-extensions',
                '--disable-plugins-discovery',
                '--start-maximized'
            ]
        }
    }
});

console.log('Iniciando crawler con configuración de Brasil...');
console.log(`🖥️  Modo: ${isHeadless ? 'Headless (sin mostrar navegador)' : 'Con interfaz gráfica'}`);
console.log(`📋 URLs a procesar: ${BRAZIL_CONFIG.urls.length}`);
BRAZIL_CONFIG.urls.forEach((url, index) => {
    let origin = 'Unknown';
    let destination = 'Unknown';
    
    if (url.includes('MCZ')) destination = 'Maceió';
    
    if (url.includes('/m/09cv2b')) origin = 'Mexico City';
    else if (url.includes('/g/11bc6xlppd')) origin = 'Florianópolis';
    
    let date = 'Unknown';
    if (url.includes('2025-08-16')) date = 'Aug 16';
    if (url.includes('2025-08-23')) date = 'Aug 23';
    if (url.includes('2025-08-30')) date = 'Aug 30';
    if (url.includes('2025-09-06')) date = 'Sep 6';
    if (url.includes('2025-09-13')) date = 'Sep 13';
    if (url.includes('2025-09-27')) date = 'Sep 27';
    if (url.includes('2025-09-20')) date = 'Sep 20';
    
    console.log(`   ${index + 1}. ${origin} → ${destination} - ${date}: ${url.substring(0, 100)}...`);
});

await crawler.run(BRAZIL_CONFIG.urls);

console.log('\n🎉 Procesamiento de todas las URLs completado!');
console.log('🔚 Terminando proceso...');
process.exit(0);