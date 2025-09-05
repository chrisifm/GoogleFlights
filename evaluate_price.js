import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';
import { updatePriceAnalytics, detectPriceChanges, getAnalyticsSummary, generateRouteId } from './price_analytics.js';
import { sendPriceAlert, getNotificationsHistory } from './send_notifications.js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Función para actualizar o crear registro en historical_prices
async function updateHistoricalPrice(fromCity, toCity, flightDate, priceStats) {
    try {
        // Buscar registro existente
        const { data: existing, error: selectError } = await supabase
            .from('historical_prices')
            .select('*')
            .eq('from_city', fromCity)
            .eq('to_city', toCity)
            .eq('flight_date', flightDate)
            .single();

        if (selectError && selectError.code !== 'PGRST116') { // PGRST116 = no rows found
            console.error('Error al buscar precio histórico:', selectError.message);
            return false;
        }

        const now = new Date().toISOString();
        
        if (existing) {
            // Comparar estadísticas actuales vs nuevas
            const currentBestPrice = parseFloat(existing.best_price);
            const currentMaxPrice = parseFloat(existing.max_price) || 0;
            const currentMinPrice = parseFloat(existing.min_price) || currentBestPrice;
            const currentAvgPrice = parseFloat(existing.average_price) || currentBestPrice;
            
            const newBestPrice = priceStats.minPrice;
            const isPriceBetter = newBestPrice < currentBestPrice;
            const isMaxHigher = priceStats.maxPrice > currentMaxPrice;
            const isMinLower = priceStats.minPrice < currentMinPrice;
            
            console.log(`📊 Estadísticas actuales: Min: ${priceStats.currency}$${currentMinPrice} | Avg: ${priceStats.currency}$${currentAvgPrice} | Max: ${priceStats.currency}$${currentMaxPrice}`);
            console.log(`💰 Estadísticas nuevas: Min: ${priceStats.currency}$${priceStats.minPrice} | Avg: ${priceStats.currency}$${priceStats.averagePrice} | Max: ${priceStats.currency}$${priceStats.maxPrice}`);
            console.log(`📈 Mejor precio mejoró: ${isPriceBetter ? 'SÍ' : 'NO'}`);
            
            let priceTrend = 'stable';
            if (isPriceBetter) {
                priceTrend = 'decreasing';
            } else if (newBestPrice > currentBestPrice) {
                priceTrend = 'increasing';
            }
            
            // Actualizar registro con nuevas estadísticas
            const updateData = {
                best_price: Math.min(currentBestPrice, priceStats.minPrice),
                max_price: Math.max(currentMaxPrice, priceStats.maxPrice),
                min_price: Math.min(currentMinPrice, priceStats.minPrice),
                average_price: priceStats.averagePrice, // Usar promedio más reciente
                best_price_currency: priceStats.currency,
                last_updated: now,
                price_trend: priceTrend
            };
            
            const { error: updateError } = await supabase
                .from('historical_prices')
                .update(updateData)
                .eq('id', existing.id);

            if (updateError) {
                console.error('Error al actualizar estadísticas históricas:', updateError.message);
                return false;
            }
            
            if (isPriceBetter) {
                console.log('✅ Estadísticas actualizadas (nuevo mejor precio)');
                return {
                    isNewBest: true,
                    priceDrop: currentBestPrice - newBestPrice,
                    previousPrice: currentBestPrice
                };
            } else {
                console.log('📝 Estadísticas actualizadas (no es mejor precio)');
                return {
                    isNewBest: false,
                    priceDrop: 0,
                    previousPrice: currentBestPrice
                };
            }
        } else {
            // Crear nuevo registro con estadísticas completas
            const { error: insertError } = await supabase
                .from('historical_prices')
                .insert([{
                    from_city: fromCity,
                    to_city: toCity,
                    flight_date: flightDate,
                    best_price: priceStats.minPrice,
                    max_price: priceStats.maxPrice,
                    min_price: priceStats.minPrice,
                    average_price: priceStats.averagePrice,
                    best_price_currency: priceStats.currency,
                    last_updated: now,
                    price_trend: 'stable',
                    created_at: now
                }]);

            if (insertError) {
                console.error('Error al crear registro histórico:', insertError.message);
                return false;
            }
            
            console.log('✅ Nuevo registro histórico creado con estadísticas completas');
            console.log(`📊 Min: ${priceStats.currency}$${priceStats.minPrice} | Avg: ${priceStats.currency}$${priceStats.averagePrice} | Max: ${priceStats.currency}$${priceStats.maxPrice}`);
            return {
                isNewBest: true,
                priceDrop: 0,
                previousPrice: null
            };
        }
    } catch (error) {
        console.error('Error crítico en updateHistoricalPrice:', error.message);
        return false;
    }
}

// Función para encontrar el mejor precio histórico real de una ruta
async function findBestHistoricalPrice(fromCity, toCity, flightDate) {
    try {
        // Obtener TODOS los precios históricos de esta ruta/fecha
        const { data: allPrices, error } = await supabase
            .from('flights')
            .select('price, currency, updated_at')
            .eq('from', fromCity)
            .eq('to', toCity)
            .eq('flight_date', flightDate)
            .order('price', { ascending: true }); // Ordenar por precio, más barato primero

        if (error) {
            console.error('Error al obtener precios históricos completos:', error.message);
            return null;
        }

        if (!allPrices || allPrices.length === 0) {
            return null;
        }

        const allPricesValues = allPrices.map(p => p.price);
        const minPrice = Math.min(...allPricesValues);
        const maxPrice = Math.max(...allPricesValues);
        const avgPrice = allPricesValues.reduce((a, b) => a + b, 0) / allPricesValues.length;

        return {
            minPrice: minPrice,
            maxPrice: maxPrice,
            averagePrice: Math.round(avgPrice * 100) / 100, // Redondear a 2 decimales
            currency: allPrices[0].currency,
            totalRecords: allPrices.length,
            allPrices: allPricesValues
        };
        
    } catch (error) {
        console.error('Error crítico buscando mejor precio histórico:', error.message);
        return null;
    }
}

// Función para analizar precios de una fecha específica
async function analyzePricesForDate(flightDate) {
    try {
        console.log(`\n🔍 Analizando precios para la fecha: ${flightDate}`);
        
        // Obtener todas las rutas únicas para esta fecha
        const { data: allRoutes, error: routesError } = await supabase
            .from('flights')
            .select('from, to')
            .eq('flight_date', flightDate)
            .order('updated_at', { ascending: false });

        if (routesError) {
            console.error('Error al obtener rutas:', routesError.message);
            return false;
        }

        if (!allRoutes || allRoutes.length === 0) {
            console.log('📭 No hay rutas para analizar');
            return false;
        }

        // Crear conjunto único de rutas
        const uniqueRoutes = new Map();
        allRoutes.forEach(route => {
            const routeKey = `${route.from}-${route.to}`;
            if (!uniqueRoutes.has(routeKey)) {
                uniqueRoutes.set(routeKey, route);
            }
        });

        console.log(`🛣️ Analizando ${uniqueRoutes.size} rutas únicas en total`);
        
        const alerts = [];
        let routesAnalyzed = 0;

        // Analizar cada ruta única
        for (const [routeKey, route] of uniqueRoutes) {
            routesAnalyzed++;
            console.log(`\n🔍 [${routesAnalyzed}/${uniqueRoutes.size}] Analizando: ${route.from} → ${route.to}`);
            
            // Obtener el mejor precio histórico REAL de todos los registros
            const historicalData = await findBestHistoricalPrice(route.from, route.to, flightDate);
            
            if (!historicalData) {
                console.log('📭 No hay datos históricos para esta ruta');
                continue;
            }

            console.log(`📊 Registros históricos: ${historicalData.totalRecords}`);
            console.log(`💰 Rango de precios: ${historicalData.currency}$${historicalData.minPrice} - ${historicalData.currency}$${historicalData.maxPrice}`);
            console.log(`📈 Precio promedio: ${historicalData.currency}$${historicalData.averagePrice}`);

            // Actualizar o crear registro en historical_prices
            const analysis = await updateHistoricalPrice(
                route.from,
                route.to,
                flightDate,
                historicalData
            );
            
            if (analysis && analysis.isNewBest && analysis.previousPrice !== null) {
                const priceDrop = analysis.priceDrop;
                console.log(`💰 Mejor precio actualizado: bajada de ${historicalData.currency}$${priceDrop}`);
                
                // Determinar si enviar alerta
                let shouldAlert = false;
                let alertReason = '';
                
                if (priceDrop >= CONFIG.ALERTS.PRICE_DROP_THRESHOLD) {
                    shouldAlert = true;
                    alertReason = `Bajada significativa de $${priceDrop} ${historicalData.currency}`;
                }
                
                if (shouldAlert) {
                    console.log(`🚨 CRITERIO PARA ALERTA CUMPLIDO: ${alertReason}`);
                    
                    const alertSent = await sendPriceAlert(
                        route.from,
                        route.to,
                        historicalData.minPrice,
                        historicalData.currency,
                        flightDate,
                        alertReason
                    );
                    
                    if (alertSent) {
                        alerts.push({
                            route: `${route.from} → ${route.to}`,
                            price: historicalData.minPrice,
                            currency: historicalData.currency,
                            priceDrop: priceDrop,
                            reason: alertReason
                        });
                    }
                } else {
                    console.log('📝 No cumple criterios para alerta');
                }
            } else if (analysis && !analysis.isNewBest) {
                console.log('📊 Precio histórico actual sigue siendo el mejor');
            } else if (analysis && analysis.previousPrice === null) {
                console.log('✅ Primer registro histórico creado');
            }
        }
        
        // Resumen final
        console.log('\n📋 RESUMEN DEL ANÁLISIS:');
        console.log(`   - Rutas analizadas: ${routesAnalyzed}`);
        console.log(`   - Alertas enviadas: ${alerts.length}`);
        
        if (alerts.length > 0) {
            console.log('\n🚨 ALERTAS ENVIADAS:');
            alerts.forEach(alert => {
                console.log(`   - ${alert.route}: ${alert.currency}$${alert.price} (${alert.reason})`);
            });
        }
        
        return {
            routesAnalyzed: routesAnalyzed,
            alertsSent: alerts.length,
            alerts: alerts
        };
        
    } catch (error) {
        console.error('Error crítico en análisis de precios:', error.message);
        return false;
    }
}

// Función principal del evaluador de precios (optimizada para detección de bajadas ≥$400)
export async function runPriceEvaluator(flightDate = null) {
    console.log('📊 Iniciando Evaluador de Precios Avanzado');
    console.log('=========================================\n');
    
    try {
        // Si no se especifica fecha, usar fecha de los trabajos de configuración más común
        if (!flightDate) {
            const { data: commonDate, error } = await supabase
                .from('config_flights')
                .select('flight_date')
                .eq('is_active', true)
                .limit(1)
                .single();
                
            if (error) {
                console.error('Error al obtener fecha de configuración:', error.message);
                return null;
            }
            
            flightDate = commonDate.flight_date;
            console.log(`📅 Usando fecha de configuración: ${flightDate}`);
        }
        
        // PASO 1: Obtener el precio más reciente de cada ruta (simulando lo que acabó de capturar el web scraper)
        const { data: recentFlights, error: recentError } = await supabase
            .from('flights')
            .select('from, to, price, currency, updated_at')
            .eq('flight_date', flightDate)
            .order('updated_at', { ascending: false });

        if (recentError) {
            console.error('Error obteniendo vuelos recientes:', recentError.message);
            return false;
        }

        if (!recentFlights || recentFlights.length === 0) {
            console.log('📭 No hay vuelos para analizar');
            return false;
        }

        // Agrupar por ruta y tomar el más reciente de cada una
        const routeMap = new Map();
        recentFlights.forEach(flight => {
            const routeKey = `${flight.from}-${flight.to}`;
            if (!routeMap.has(routeKey) || new Date(flight.updated_at) > new Date(routeMap.get(routeKey).updated_at)) {
                routeMap.set(routeKey, flight);
            }
        });

        console.log(`🛣️ Analizando ${routeMap.size} rutas únicas`);
        
        const alerts = [];
        let routesAnalyzed = 0;

        // PASO 2: Para cada ruta, actualizar analytics y detectar cambios
        for (const [routeKey, flight] of routeMap) {
            routesAnalyzed++;
            console.log(`\n🔍 [${routesAnalyzed}/${routeMap.size}] Procesando: ${flight.from} → ${flight.to}`);
            
            // PASO 2A: Actualizar analytics completos
            const analyticsResult = await updatePriceAnalytics(flight.from, flight.to, flightDate);
            
            if (!analyticsResult) {
                console.log('❌ Error actualizando analytics');
                continue;
            }
            
            // PASO 2B: Detectar cambios significativos (≥$400 MXN)
            const changeDetection = await detectPriceChanges(flight.from, flight.to, flightDate, flight.price);
            
            if (changeDetection && changeDetection.shouldAlert) {
                console.log(`🚨 BAJADA SIGNIFICATIVA DETECTADA: ${changeDetection.alertReason}`);
                
                // Generar routeId para logging
                const routeId = generateRouteId(flight.from, flight.to, flightDate);
                const oldPrice = flight.price + Math.abs(changeDetection.priceChange);
                const priceDrop = Math.abs(changeDetection.priceChange);
                
                // Enviar alerta via PushCut con logging
                const alertSent = await sendPriceAlert(
                    flight.from,
                    flight.to,
                    flight.price,
                    flight.currency,
                    flightDate,
                    changeDetection.alertReason,
                    routeId,
                    oldPrice,
                    priceDrop
                );
                
                if (alertSent) {
                    // Actualizar contador de alertas en analytics
                    const { error: alertUpdateError } = await supabase
                        .from('price_analytics')
                        .update({ 
                            last_alert_sent_at: new Date().toISOString()
                        })
                        .eq('route_id', analyticsResult.routeId);
                        
                    // Incrementar contador usando RPC
                    await supabase.rpc('increment_alert_counter', { 
                        p_route_id: analyticsResult.routeId 
                    });
                    
                    alerts.push({
                        route: `${flight.from} → ${flight.to}`,
                        price: flight.price,
                        currency: flight.currency,
                        priceDrop: priceDrop,
                        reason: changeDetection.alertReason,
                        changeType: changeDetection.changeType
                    });
                } else {
                    console.log('❌ Error enviando alerta');
                }
            } else if (changeDetection) {
                console.log(`📝 Cambio registrado (${changeDetection.changeType}) pero no requiere alerta`);
            }
        }
        
        // PASO 3: Mostrar resumen de analytics
        console.log('\n🔄 Generando resumen de analytics...');
        await getAnalyticsSummary();
        
        // PASO 4: Resumen final
        console.log('\n📋 RESUMEN DEL ANÁLISIS AVANZADO:');
        console.log('================================');
        console.log(`   - Rutas analizadas: ${routeMap.size}`);
        console.log(`   - Alertas enviadas: ${alerts.length}`);
        console.log(`   - Umbral configurado: ≥$${CONFIG.ALERTS.PRICE_DROP_THRESHOLD} MXN`);
        
        if (alerts.length > 0) {
            console.log('\n🚨 ALERTAS ENVIADAS:');
            alerts.forEach(alert => {
                console.log(`   • ${alert.route}: $${alert.price} ${alert.currency}`);
                console.log(`     📉 ${alert.reason} (${alert.changeType})`);
            });
        } else {
            console.log('\n📝 No se detectaron bajadas significativas ≥$400 MXN');
        }
        
        return {
            routesAnalyzed: routeMap.size,
            alertsSent: alerts.length,
            alerts: alerts,
            threshold: CONFIG.ALERTS.PRICE_DROP_THRESHOLD
        };
        
    } catch (error) {
        console.error('❌ Error crítico en evaluador avanzado:', error.message);
        return null;
    }
}

// Función para obtener resumen de precios históricos
export async function getHistoricalSummary() {
    try {
        const { data: summary, error } = await supabase
            .from('historical_prices')
            .select('from_city, to_city, flight_date, best_price, best_price_currency, price_trend, last_updated')
            .order('last_updated', { ascending: false });

        if (error) {
            console.error('Error al obtener resumen histórico:', error.message);
            return null;
        }

        console.log('\n📊 RESUMEN DE PRECIOS HISTÓRICOS:');
        console.log('=================================');
        
        if (summary && summary.length > 0) {
            summary.forEach(record => {
                const trendIcon = record.price_trend === 'decreasing' ? '📉' : 
                                 record.price_trend === 'increasing' ? '📈' : '📊';
                console.log(`${trendIcon} ${record.from_city} → ${record.to_city}`);
                console.log(`   Mejor precio: ${record.best_price_currency}$${record.best_price}`);
                console.log(`   Tendencia: ${record.price_trend}`);
                console.log(`   Actualizado: ${new Date(record.last_updated).toLocaleString('es-MX')}`);
                console.log('');
            });
        } else {
            console.log('📭 No hay registros históricos disponibles');
        }

        return summary;
    } catch (error) {
        console.error('Error al obtener resumen histórico:', error.message);
        return null;
    }
}

// Re-exportar la función desde send_notifications.js para mantener compatibilidad
export { getNotificationsHistory } from './send_notifications.js';