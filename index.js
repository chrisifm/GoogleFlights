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

// Verificar conexión a Supabase
async function testSupabaseConnection() {
    try {
        const { data, error } = await supabase
            .from('flights')
            .select('count', { count: 'exact', head: true });
        
        if (error) {
            console.error('❌ Error al conectar con Supabase:', error.message);
            return false;
        }
        
        console.log('✅ Conexión exitosa con Supabase');
        console.log(`📊 Total de registros en tabla flights: ${data || 0}`);
        return true;
    } catch (error) {
        console.error('❌ Error de conexión con Supabase:', error.message);
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
async function sendPriceAlert(from, to, currentPrice, currency, flightDate) {
    try {
        const response = await fetch('https://api.pushcut.io/eOU0kCDr2y95dXanO0nwk/notifications/Google%20Flights', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: `¡Bajo de precio! Nuevo precio más bajo: ${currency}$${currentPrice} para ${flightDate}`,
                title: `Vuelo ${from}/${to}`
            })
        });

        if (response.ok) {
            console.log('🚨 Alerta de precio bajo enviada exitosamente');
        } else {
            console.error('Error al enviar alerta:', response.statusText);
        }
    } catch (error) {
        console.error('Error al enviar alerta:', error);
    }
}

// Función para verificar si es el precio más bajo y enviar alerta
async function checkLowestPrice(from, to, currentPrice, currency, currentLink, flightDate) {
    try {
        // Obtener todos los vuelos con el mismo origen, destino, link y fecha
        const { data: flights, error } = await supabase
            .from('flights')
            .select('price, currency, link, flight_date')
            .eq('from', from)
            .eq('to', to)
            .eq('link', currentLink)
            .eq('flight_date', flightDate)
            .order('price', { ascending: true });

        if (error) {
            console.error('Error al consultar precios históricos:', error);
            return false;
        }

        console.log(`📊 Encontrados ${flights.length} vuelos históricos para ${from} -> ${to} (${flightDate})`);
        
        if (flights.length > 1) { // Necesitamos al menos 2 registros para comparar
            const lowestPrice = flights[0].price; // El más bajo
            const highestPrice = flights[flights.length - 1].price; // El más alto (último en orden ascendente)
            
            console.log(`💰 Precio actual: ${currency}$${currentPrice}`);
            console.log(`📉 Precio más bajo histórico: ${flights[0].currency}$${lowestPrice}`);
            console.log(`📈 Precio más alto histórico: ${currency}$${highestPrice}`);
            console.log(`📅 Fecha del vuelo: ${flightDate}`);
            console.log(`🔗 Comparando solo vuelos de la misma fecha/ruta: ${currentLink.substring(0, 50)}...`);
            
            // Verificar si es el nuevo precio más bajo
            const isLowestPrice = currentPrice <= lowestPrice;
            
            // Verificar si es al menos $500 MX más barato que el más caro
            const savingsFromHighest = highestPrice - currentPrice;
            const significantSavings = savingsFromHighest >= 500;
            
            console.log(`💸 Ahorro vs precio más alto: $${savingsFromHighest} MX`);
            
            if (isLowestPrice && significantSavings) {
                console.log('🎉 ¡Nuevo precio más bajo detectado con ahorro significativo!');
                console.log(`🚨 Enviando alerta: Es el más bajo Y ahorra +$500 MX vs el más caro`);
                await sendPriceAlert(from, to, currentPrice, currency, flightDate);
                return true;
            } else if (isLowestPrice) {
                console.log('📝 Es el precio más bajo, pero el ahorro vs el más caro es menor a $500 MX');
            } else {
                console.log('📝 No es el precio más bajo histórico');
            }
        } else {
            console.log('📈 Primer registro para esta fecha/ruta específica - no hay comparación histórica');
        }
        
        return false;
    } catch (error) {
        console.error('Error al verificar precio más bajo:', error);
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
            return false;
        }

        return existingFlights.length > 0;
    } catch (error) {
        console.error('Error al verificar duplicados:', error);
        return false;
    }
}

// Función para insertar vuelo en Supabase
async function insertFlight(from, to, priceString, link, flightDate = null) {
    try {
        const { currency, price } = parsePrice(priceString);
        
        // Verificar si ya existe un registro con los mismos from, to, price, link, flight_date
        const isDuplicate = await checkDuplicateRecord(from, to, price, link, flightDate);
        
        if (isDuplicate) {
            console.log('⚠️  Registro duplicado encontrado. No se insertará.');
            console.log(`   From: ${from}, To: ${to}, Price: ${currency}$${price}, Date: ${flightDate}, Link: ${link.substring(0, 50)}...`);
            console.log('📝 Ya existe un registro igual en la base de datos');
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
            return false;
        }

        console.log('✅ Vuelo insertado exitosamente en Supabase');
        
        // Verificar si es el precio más bajo después de insertar
        await checkLowestPrice(from, to, price, currency, link, flightDate);
        
        return true;
    } catch (error) {
        console.error('Error de conexión con Supabase:', error);
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
  
  // URLs de Google Flights a comprobar
  urls: [
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTA2ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTI3ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTE2ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTIzahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTMwahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTA2ahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA4LTMwahEIAhIKL20vMDljdjJiahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTA2ahEIAhIKL20vMDljdjJiahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN',
    'https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI1LTA5LTEzahEIAhIKL20vMDljdjJiahEIAhINL2cvMTFiYzZ4bHBwZHIHCAESA01DWkABSAFwAYIBCwj___________8BmAEC&curr=MXN'
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
        
        // Verificar conexión a Supabase para cada URL
        console.log('🔗 Verificando conexión a Supabase...');
        const isConnected = await testSupabaseConnection();
        
        if (!isConnected) {
            console.error('❌ No se pudo conectar a Supabase para esta URL.');
            return; // Continuar con la siguiente URL en lugar de terminar
        }
        
        console.log('Configurando navegador con configuración de Brasil...');
        
        // Configurar viewport
        await page.setViewportSize(BRAZIL_CONFIG.viewport);
        
        // Configurar headers realistas para evitar detección
        const randomUserAgent = REAL_USER_AGENTS[Math.floor(Math.random() * REAL_USER_AGENTS.length)];
        
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
        
        try {
            // Extraer origen y destino desde el título
            const titleParts = title.split(' to ');
            if (titleParts.length >= 2) {
                fromCity = titleParts[0].trim();
                toCity = titleParts[1].split(' |')[0].trim();
            }
            
            // Extraer fecha del campo de filtros
            const dateSelectors = [
                'input.TP4Lpb.eoY5cb.j0Ppje[aria-label="Departure"]',
                'input[placeholder="Departure"]',
                'input.TP4Lpb',
                '[jsname="yrriRe"]'
            ];
            
            for (const dateSelector of dateSelectors) {
                try {
                    const dateValue = await page.$eval(dateSelector, el => el.value || el.textContent);
                    if (dateValue && dateValue.trim() && dateValue !== 'Departure') {
                        flightDate = dateValue.trim();
                        console.log(`📅 Fecha extraída: ${flightDate}`);
                        break;
                    }
                } catch (e) {
                    // Continuar con el siguiente selector
                }
            }
            
            if (flightDate === 'No encontrado') {
                console.log('⚠️  No se pudo extraer la fecha del vuelo');
            }
            
            // Buscar precio usando el patrón MX$ observado
            const priceElement = await page.$eval('.pIav2d', element => {
                const text = element.textContent;
                const priceMatch = text.match(/MX\$[\d,]+/);
                return priceMatch ? priceMatch[0] : null;
            });
            
            if (priceElement) {
                flightPrice = priceElement;
            }
            
        } catch (error) {
            console.log('Error al extraer información del vuelo:', error.message);
        }
        
        // Imprimir solo el precio
        console.log(flightPrice);
        
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