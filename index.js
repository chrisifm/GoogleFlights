import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Cargar variables de entorno desde .env
dotenv.config();

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

// Función para obtener configuraciones de vuelos desde Supabase
async function getFlightConfigs() {
    try {
        const { data: configs, error } = await supabase
            .from('config_flights')
            .select('*')
            .eq('is_active', true)
            .order('priority', { ascending: false })
            .order('flight_date', { ascending: true });

        if (error) {
            console.error('Error al obtener configuraciones de vuelos:', error);
            await logError({
                error_type: 'CONFIG_FETCH_ERROR',
                error_message: error.message,
                log_details: `Error al obtener configuraciones: ${JSON.stringify(error, null, 2)}`,
                network_status: 'Failed'
            });
            return [];
        }

        console.log(`✅ Configuraciones obtenidas: ${configs.length} rutas activas`);
        return configs;
    } catch (error) {
        console.error('Error crítico al obtener configuraciones:', error);
        await logError({
            error_type: 'CONFIG_FETCH_CRITICAL_ERROR',
            error_message: error.message,
            log_details: `Error crítico: ${error.message}`,
            stack_trace: error.stack || null
        });
        return [];
    }
}

// Función para construir URL de Google Flights dinámicamente usando navegación
async function buildGoogleFlightsUrl(page, origin, destination, date) {
    try {
        console.log(`🔨 Construyendo búsqueda: ${origin} → ${destination} el ${date}`);
        
        // Navegar a Google Flights
        await page.goto('https://www.google.com/travel/flights', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        // Configurar viaje solo de ida
        try {
            await page.click('[aria-label="Round trip"]', { timeout: 5000 });
            await page.waitForTimeout(1000);
            await page.click('text=One way', { timeout: 5000 });
            console.log('✅ Configurado como viaje solo de ida');
        } catch (e) {
            console.log('⚠️ No se pudo configurar viaje solo de ida, continuando...');
        }

        // Configurar viaje solo de ida clickeando en el dropdown
        try {
            await page.click('[aria-label="Ida y vuelta"]', { timeout: 5000 });
            await page.waitForTimeout(1000);
            await page.click('[role="option"]:has-text("Solo ida")', { timeout: 5000 });
            console.log('✅ Configurado como viaje solo de ida');
        } catch (e) {
            console.log('⚠️ No se pudo configurar viaje solo de ida específicamente, continuando...');
        }

        // Campo de origen usando selector actualizado
        try {
            await page.click('input.II2One[aria-label*="dónde"]', { timeout: 10000 });
            await page.fill('input.II2One[aria-label*="dónde"]', '');  // Limpiar campo
            await page.keyboard.type(origin);
            await page.waitForTimeout(2000);
            await page.keyboard.press('Tab'); // Confirmar origen
            console.log(`✅ Origen configurado: ${origin}`);
        } catch (e) {
            console.log('⚠️ Error configurando origen:', e.message);
        }

        // Campo de destino - buscar el segundo campo de entrada
        try {
            // Buscar campos de destino más específicos
            const destSelectors = [
                'input[aria-label*="Adónde"]',
                'input[aria-label*="destino"]', 
                'input.II2One:not([aria-label*="dónde"])',
                'input[placeholder*="destino"]'
            ];
            
            let destConfigured = false;
            for (const selector of destSelectors) {
                try {
                    await page.click(selector, { timeout: 3000 });
                    await page.keyboard.type(destination);
                    await page.waitForTimeout(2000);
                    await page.keyboard.press('Tab');
                    console.log(`✅ Destino configurado: ${destination} (selector: ${selector})`);
                    destConfigured = true;
                    break;
                } catch (e) {
                    continue;
                }
            }
            
            if (!destConfigured) {
                // Fallback: usar Tab desde origen y escribir destino
                await page.keyboard.type(destination);
                await page.waitForTimeout(2000);
                await page.keyboard.press('Tab');
                console.log(`✅ Destino configurado (fallback): ${destination}`);
            }
        } catch (e) {
            console.log('⚠️ Error configurando destino:', e.message);
        }

        // Campo de fecha usando selector actualizado
        try {
            await page.click('input.TP4Lpb[placeholder="Salida"]', { timeout: 5000 });
            await page.fill('input.TP4Lpb[placeholder="Salida"]', '');  // Limpiar campo
            await page.keyboard.type(date);
            await page.waitForTimeout(2000);
            await page.keyboard.press('Enter');
            console.log(`✅ Fecha configurada: ${date}`);
        } catch (e) {
            console.log('⚠️ Error configurando fecha:', e.message);
        }

        // Buscar vuelos
        try {
            await page.click('button[aria-label*="Search"], button[jsname="kH2m2b"]', { timeout: 5000 });
            console.log('🔍 Iniciando búsqueda...');
            await page.waitForTimeout(8000); // Esperar que carguen los resultados
        } catch (e) {
            console.log('⚠️ Error al hacer click en buscar, intentando Enter');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(8000);
        }

        const currentUrl = page.url();
        console.log(`✅ URL construida: ${currentUrl.substring(0, 100)}...`);
        
        return currentUrl;
    } catch (error) {
        console.error('Error construyendo URL de búsqueda:', error.message);
        await logError({
            error_type: 'URL_BUILD_ERROR',
            error_message: error.message,
            log_details: `Error construyendo búsqueda para ${origin} → ${destination} el ${date}`,
            from: origin,
            to: destination,
            flight_date: date,
            stack_trace: error.stack || null
        });
        return null;
    }
}

// Configuración para Argentina
const ARGENTINA_CONFIG = {
  // Geolocalización para Buenos Aires, Argentina
  latitude: -34.6037,
  longitude: -58.3816,
  
  // Timezone de Argentina
  timezone: 'America/Argentina/Buenos_Aires',
  
  // Configuración de idioma y región
  locale: 'es-AR',
  
  // Las URLs ahora se obtienen dinámicamente desde la base de datos
  urls: [], // Se llenará dinámicamente
  
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
        console.log(`\n🌐 Procesando configuración de vuelo`);
        console.log('='.repeat(80));
        
        // Extraer información de la configuración desde la metadata del request
        const flightConfig = request.userData?.flightConfig;
        if (!flightConfig) {
            console.error('❌ No se encontró configuración de vuelo en request');
            return;
        }
        
        console.log(`📋 Configuración: ${flightConfig.origin_city} → ${flightConfig.destination_city}`);
        console.log(`📅 Fecha: ${flightConfig.flight_date}`);
        console.log(`🎯 Prioridad: ${flightConfig.priority}`);
        
        // Configurar User Agent al inicio para que esté disponible en todo el scope
        const randomUserAgent = REAL_USER_AGENTS[Math.floor(Math.random() * REAL_USER_AGENTS.length)];
        
        // Verificar conexión a Supabase
        console.log('🔗 Verificando conexión a Supabase...');
        const isConnected = await testSupabaseConnection();
        
        if (!isConnected) {
            console.error('❌ No se pudo conectar a Supabase para esta configuración.');
            
            // Log error de conexión
            await logError({
                error_type: 'SUPABASE_CONNECTION_CONFIG',
                error_message: 'No se pudo conectar a Supabase para procesar configuración',
                log_details: `Configuración: ${flightConfig.origin_city} → ${flightConfig.destination_city}`,
                from: flightConfig.origin_city,
                to: flightConfig.destination_city,
                flight_date: flightConfig.flight_date,
                network_status: 'Connection Failed'
            });
            
            return; // Continuar con la siguiente configuración
        }
        
        console.log('Configurando navegador con configuración de Brasil...');
        
        // Configurar viewport
        await page.setViewportSize(ARGENTINA_CONFIG.viewport);
        
        // Configurar headers realistas para evitar detección (ya declarado arriba)
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': `${ARGENTINA_CONFIG.locale},es;q=0.9,en;q=0.8`,
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
        
        // Configurar geolocalización para Buenos Aires
        await page.context().setGeolocation({
            latitude: ARGENTINA_CONFIG.latitude,
            longitude: ARGENTINA_CONFIG.longitude
        });
        
        // Script anti-detección y configuración de timezone
        await page.context().addInitScript(() => {
            // Override timezone
            Object.defineProperty(Intl, 'DateTimeFormat', {
                value: function(...args) {
                    if (args.length === 0 || (args.length === 1 && typeof args[0] === 'object' && args[0].timeZone === undefined)) {
                        args[0] = { ...args[0], timeZone: 'America/Argentina/Buenos_Aires' };
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
        console.log(`- Geolocalización: Buenos Aires (${ARGENTINA_CONFIG.latitude}, ${ARGENTINA_CONFIG.longitude})`);
        console.log(`- Timezone: ${ARGENTINA_CONFIG.timezone}`);
        console.log(`- Locale: ${ARGENTINA_CONFIG.locale}`);
        console.log(`- Viewport: ${ARGENTINA_CONFIG.viewport.width}x${ARGENTINA_CONFIG.viewport.height}`);
        console.log(`- User Agent: ${randomUserAgent}`);
        
        // Construir la URL de búsqueda dinámicamente
        console.log('🔨 Construyendo búsqueda de vuelos...');
        const searchUrl = await buildGoogleFlightsUrl(
            page, 
            flightConfig.origin_city, 
            flightConfig.destination_city, 
            flightConfig.flight_date
        );
        
        if (!searchUrl) {
            console.error('❌ No se pudo construir la URL de búsqueda');
            await logError({
                error_type: 'URL_BUILD_FAILED',
                error_message: 'No se pudo construir la URL de búsqueda',
                from: flightConfig.origin_city,
                to: flightConfig.destination_city,
                flight_date: flightConfig.flight_date
            });
            return;
        }
        
        console.log(`- URL construida: ${searchUrl.substring(0, 100)}...`);
        
        const title = await page.title();
        console.log(`Título de la página: ${title}`);
        
        // Esperar a que cargue la tabla de vuelos
        console.log('Esperando a que cargue la tabla de vuelos...');
        await page.waitForTimeout(5000);
        
        // Extraer información del vuelo y precio
        let flightPrice = 'No encontrado';
        let fromCity = flightConfig.origin_city;
        let toCity = flightConfig.destination_city;
        let flightDate = flightConfig.flight_date;
        let extractionErrors = [];
        let successfulSelector = null;
        
        console.log(`🛫 Usando configuración: ${fromCity} → ${toCity} el ${flightDate}`);
        
        try {
            
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
                    viewport: `${ARGENTINA_CONFIG.viewport.width}x${ARGENTINA_CONFIG.viewport.height}`,
                    content_html: relevantHTML
                });
                
            } catch (htmlError) {
                console.error('Error al capturar HTML para logging:', htmlError.message);
            }
        }
        
        // Insertar en Supabase si se encontró el precio
        if (flightPrice !== 'No encontrado') {
            await insertFlight(fromCity, toCity, flightPrice, searchUrl, flightDate);
        }
        
        await pushData({ 
            title, 
            url: searchUrl,
            timestamp: new Date().toLocaleString('es-AR', { timeZone: ARGENTINA_CONFIG.timezone }),
            location: 'Buenos Aires, Argentina',
            userAgent: randomUserAgent,
            viewport: ARGENTINA_CONFIG.viewport,
            flightPrice: flightPrice,
            fromCity: fromCity,
            toCity: toCity,
            flightDate: flightDate,
            configId: flightConfig.id
        });
        
        // Marcar como completada esta URL
        console.log('✅ Extracción completada para esta URL.');
        console.log('='.repeat(80));
    },
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

console.log('Iniciando crawler con configuración de Argentina...');
console.log(`🖥️  Modo: ${isHeadless ? 'Headless (sin mostrar navegador)' : 'Con interfaz gráfica'}`);

// Obtener configuraciones de vuelos desde Supabase
console.log('📋 Obteniendo configuraciones de vuelos desde Supabase...');
const flightConfigs = await getFlightConfigs();

if (flightConfigs.length === 0) {
    console.error('❌ No se encontraron configuraciones de vuelos activas en la base de datos.');
    console.log('💡 Asegúrate de que hay registros en la tabla config_flights con is_active = true');
    process.exit(1);
}

console.log(`📊 Configuraciones encontradas: ${flightConfigs.length}`);
flightConfigs.forEach((config, index) => {
    console.log(`   ${index + 1}. ${config.origin_city} → ${config.destination_city} - ${config.flight_date} (Prioridad: ${config.priority})`);
    if (config.notes) {
        console.log(`      📝 ${config.notes}`);
    }
});

// Crear requests con las configuraciones
const requests = flightConfigs.map(config => ({
    url: 'https://www.google.com/travel/flights', // URL base que se usará como punto de partida
    userData: { flightConfig: config }
}));

console.log(`\n🚀 Procesando ${requests.length} configuraciones de vuelos...`);
await crawler.run(requests);

console.log('\n🎉 Procesamiento de todas las URLs completado!');
console.log('🔚 Terminando proceso...');
process.exit(0);