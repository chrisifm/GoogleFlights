import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Función para calcular estadísticas avanzadas
function calculateAdvancedStats(prices) {
    if (!prices || prices.length === 0) return null;
    
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const length = sortedPrices.length;
    
    // Estadísticas básicas
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const sum = prices.reduce((a, b) => a + b, 0);
    const avg = sum / length;
    
    // Mediana
    let median;
    if (length % 2 === 0) {
        median = (sortedPrices[length / 2 - 1] + sortedPrices[length / 2]) / 2;
    } else {
        median = sortedPrices[Math.floor(length / 2)];
    }
    
    // Volatilidad (desviación estándar)
    const variance = prices.reduce((acc, price) => acc + Math.pow(price - avg, 2), 0) / length;
    const volatility = Math.sqrt(variance);
    
    return {
        min: Math.round(min * 100) / 100,
        max: Math.round(max * 100) / 100,
        avg: Math.round(avg * 100) / 100,
        median: Math.round(median * 100) / 100,
        volatility: Math.round(volatility * 100) / 100,
        samples: length
    };
}

// Función para determinar tendencia basada en precios recientes
function calculateTrend(recentPrices, olderPrices) {
    if (!recentPrices.length || !olderPrices.length) return 'stable';
    
    const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const olderAvg = olderPrices.reduce((a, b) => a + b, 0) / olderPrices.length;
    
    const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;
    
    if (changePercent > 5) return 'up';
    if (changePercent < -5) return 'down';
    return 'stable';
}

// Función para generar route_id único
function generateRouteId(fromCity, toCity, flightDate) {
    return `${fromCity}::${toCity}::${flightDate}`;
}

// Función principal para actualizar analytics de una ruta
async function updatePriceAnalytics(fromCity, toCity, flightDate) {
    try {
        const routeId = generateRouteId(fromCity, toCity, flightDate);
        console.log(`🔍 Actualizando analytics para: ${routeId}`);
        
        // Obtener TODOS los precios históricos para esta ruta
        const { data: allPrices, error: pricesError } = await supabase
            .from('flights')
            .select('price, updated_at')
            .eq('from', fromCity)
            .eq('to', toCity)
            .eq('flight_date', flightDate)
            .order('updated_at', { ascending: false });

        if (pricesError) {
            console.error('Error obteniendo precios:', pricesError.message);
            return false;
        }

        if (!allPrices || allPrices.length === 0) {
            console.log('📭 No hay datos de precios para esta ruta');
            return false;
        }

        console.log(`📊 Analizando ${allPrices.length} registros de precios`);
        
        const prices = allPrices.map(p => p.price);
        const now = new Date();
        
        // Filtrar precios por períodos
        const last24h = allPrices.filter(p => 
            new Date(p.updated_at) > new Date(now - 24 * 60 * 60 * 1000)
        ).map(p => p.price);
        
        const last7d = allPrices.filter(p => 
            new Date(p.updated_at) > new Date(now - 7 * 24 * 60 * 60 * 1000)
        ).map(p => p.price);
        
        const older7d = allPrices.filter(p => {
            const priceDate = new Date(p.updated_at);
            return priceDate <= new Date(now - 7 * 24 * 60 * 60 * 1000) && 
                   priceDate > new Date(now - 14 * 24 * 60 * 60 * 1000);
        }).map(p => p.price);
        
        // Calcular estadísticas
        const currentStats = calculateAdvancedStats(prices);
        if (!currentStats) return false;
        
        // Calcular tendencias
        const trend24h = last24h.length >= 2 ? 
            calculateTrend(last24h.slice(0, Math.ceil(last24h.length / 2)), 
                          last24h.slice(Math.ceil(last24h.length / 2))) : 'stable';
        
        const trend7d = calculateTrend(last7d, older7d);
        
        // Buscar registro existente en price_analytics
        const { data: existing, error: selectError } = await supabase
            .from('price_analytics')
            .select('*')
            .eq('route_id', routeId)
            .single();

        const analyticsData = {
            route_id: routeId,
            from_city: fromCity,
            to_city: toCity,
            flight_date: flightDate,
            current_min_price: currentStats.min,
            current_max_price: currentStats.max,
            current_avg_price: currentStats.avg,
            current_median_price: currentStats.median,
            all_time_min_price: currentStats.min,
            all_time_max_price: currentStats.max,
            price_volatility: currentStats.volatility,
            total_samples: currentStats.samples,
            samples_last_24h: last24h.length,
            samples_last_7d: last7d.length,
            trend_24h: trend24h,
            trend_7d: trend7d,
            last_updated: new Date().toISOString()
        };

        if (selectError && selectError.code !== 'PGRST116') {
            console.error('Error buscando analytics:', selectError.message);
            return false;
        }

        if (existing) {
            // Actualizar registro existente
            analyticsData.all_time_min_price = Math.min(existing.all_time_min_price, currentStats.min);
            analyticsData.all_time_max_price = Math.max(existing.all_time_max_price, currentStats.max);
            analyticsData.total_alerts_sent = existing.total_alerts_sent || 0;
            analyticsData.alert_threshold = existing.alert_threshold || 400;
            
            const { error: updateError } = await supabase
                .from('price_analytics')
                .update(analyticsData)
                .eq('route_id', routeId);

            if (updateError) {
                console.error('Error actualizando analytics:', updateError.message);
                return false;
            }
            
            console.log('✅ Analytics actualizado exitosamente');
        } else {
            // Crear nuevo registro
            analyticsData.created_at = new Date().toISOString();
            analyticsData.alert_threshold = 400;
            analyticsData.total_alerts_sent = 0;
            
            const { error: insertError } = await supabase
                .from('price_analytics')
                .insert([analyticsData]);

            if (insertError) {
                console.error('Error creando analytics:', insertError.message);
                return false;
            }
            
            console.log('✅ Nuevo analytics creado exitosamente');
        }

        // Mostrar resumen
        console.log(`📈 Estadísticas calculadas:`);
        console.log(`   Min: $${currentStats.min} | Max: $${currentStats.max}`);
        console.log(`   Promedio: $${currentStats.avg} | Mediana: $${currentStats.median}`);
        console.log(`   Volatilidad: $${currentStats.volatility}`);
        console.log(`   Muestras: Total ${currentStats.samples} | 24h: ${last24h.length} | 7d: ${last7d.length}`);
        console.log(`   Tendencias: 24h: ${trend24h} | 7d: ${trend7d}`);

        return {
            routeId,
            currentStats,
            trends: { trend24h, trend7d },
            analytics: analyticsData
        };
        
    } catch (error) {
        console.error('Error crítico en updatePriceAnalytics:', error.message);
        return false;
    }
}

// Función para detectar cambios significativos de precio
async function detectPriceChanges(fromCity, toCity, flightDate, newPrice) {
    try {
        const routeId = generateRouteId(fromCity, toCity, flightDate);
        
        // Obtener analytics actual
        const { data: analytics, error: analyticsError } = await supabase
            .from('price_analytics')
            .select('*')
            .eq('route_id', routeId)
            .single();

        if (analyticsError && analyticsError.code !== 'PGRST116') {
            console.error('Error obteniendo analytics:', analyticsError.message);
            return false;
        }

        if (!analytics) {
            console.log('📭 No hay analytics previo para comparar');
            return false;
        }

        const oldMin = analytics.all_time_min_price;
        const oldAvg = analytics.current_avg_price;
        const priceChange = newPrice - oldMin;
        const changePercentage = ((newPrice - oldMin) / oldMin) * 100;

        let changeType = 'normal_fluctuation';
        let shouldAlert = false;
        let alertReason = '';

        // Determinar tipo de cambio
        if (newPrice < oldMin) {
            changeType = 'new_minimum';
            if (Math.abs(priceChange) >= analytics.alert_threshold) {
                shouldAlert = true;
                alertReason = `Nuevo mínimo histórico con bajada de $${Math.abs(priceChange)} MXN`;
            }
        } else if (Math.abs(priceChange) >= analytics.alert_threshold) {
            changeType = 'significant_drop';
            shouldAlert = true;
            alertReason = `Bajada significativa de $${Math.abs(priceChange)} MXN`;
        } else if (newPrice > oldAvg * 1.5) {
            changeType = 'price_spike';
        }

        // Registrar el cambio
        const changeRecord = {
            route_id: routeId,
            from_city: fromCity,
            to_city: toCity,
            flight_date: flightDate,
            old_price: oldMin,
            new_price: newPrice,
            price_change: priceChange,
            change_percentage: Math.round(changePercentage * 100) / 100,
            change_type: changeType,
            samples_analyzed: analytics.total_samples,
            previous_min: oldMin,
            previous_avg: oldAvg,
            alert_sent: shouldAlert,
            alert_reason: shouldAlert ? alertReason : null,
            currency: 'MXN'
        };

        const { error: insertError } = await supabase
            .from('price_changes')
            .insert([changeRecord]);

        if (insertError) {
            console.error('Error registrando cambio de precio:', insertError.message);
            return false;
        }

        console.log(`📊 Cambio de precio registrado: ${changeType}`);
        console.log(`   Cambio: $${priceChange} (${changePercentage.toFixed(2)}%)`);
        
        if (shouldAlert) {
            console.log(`🚨 Alerta requerida: ${alertReason}`);
        }

        return {
            shouldAlert,
            alertReason,
            changeType,
            priceChange,
            changePercentage
        };

    } catch (error) {
        console.error('Error crítico detectando cambios:', error.message);
        return false;
    }
}

// Función para obtener resumen de analytics
async function getAnalyticsSummary() {
    try {
        const { data: analytics, error } = await supabase
            .from('price_analytics')
            .select('*')
            .order('last_updated', { ascending: false });

        if (error) {
            console.error('Error obteniendo resumen analytics:', error.message);
            return null;
        }

        console.log('\n📊 RESUMEN DE ANALYTICS AVANZADO:');
        console.log('=================================');
        
        if (analytics && analytics.length > 0) {
            analytics.forEach(record => {
                const volatilityLevel = record.price_volatility > 200 ? '🔴 Alta' : 
                                      record.price_volatility > 100 ? '🟡 Media' : '🟢 Baja';
                
                console.log(`\n✈️ ${record.from_city} → ${record.to_city}`);
                console.log(`   💰 Rango: $${record.all_time_min_price} - $${record.all_time_max_price}`);
                console.log(`   📊 Actual: Min $${record.current_min_price} | Avg $${record.current_avg_price} | Median $${record.current_median_price}`);
                console.log(`   📈 Volatilidad: $${record.price_volatility} (${volatilityLevel})`);
                console.log(`   📋 Muestras: ${record.total_samples} total | ${record.samples_last_24h} (24h) | ${record.samples_last_7d} (7d)`);
                console.log(`   📊 Tendencias: 24h ${getTrendIcon(record.trend_24h)} | 7d ${getTrendIcon(record.trend_7d)}`);
                console.log(`   🚨 Alertas enviadas: ${record.total_alerts_sent}`);
            });
        } else {
            console.log('📭 No hay datos de analytics disponibles');
        }

        return analytics;
    } catch (error) {
        console.error('Error obteniendo resumen analytics:', error.message);
        return null;
    }
}

function getTrendIcon(trend) {
    switch (trend) {
        case 'up': return '📈';
        case 'down': return '📉';
        case 'stable': return '➡️';
        default: return '❓';
    }
}

// Exportar funciones
export { 
    updatePriceAnalytics, 
    detectPriceChanges, 
    getAnalyticsSummary,
    calculateAdvancedStats,
    generateRouteId
};