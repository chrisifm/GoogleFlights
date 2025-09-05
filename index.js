import { runWebScraper } from './web_scraper.js';
import { runPriceEvaluator, getHistoricalSummary } from './evaluate_price.js';
import { getNotificationsHistory } from './send_notifications.js';

// Función principal que orquesta el flujo completo
async function main() {
    console.log('🚀 SISTEMA DE MONITOREO DE VUELOS');
    console.log('==================================');
    console.log('📋 Flujo: Web Scraper → Evaluador de Precios\n');
    
    try {
        // PASO 1: Ejecutar Web Scraper
        console.log('🔄 PASO 1: Ejecutando Web Scraper...');
        console.log('=====================================\n');
        
        const scraperResult = await runWebScraper();
        
        if (!scraperResult) {
            console.log('\n❌ Web Scraper no devolvió resultados. Finalizando.');
            return;
        }
        
        if (!scraperResult.success) {
            console.log('\n❌ Web Scraper falló. No se ejecutará el evaluador de precios.');
            return;
        }
        
        console.log('\n✅ Web Scraper completado exitosamente');
        console.log(`📊 Datos obtenidos: ${scraperResult.flightData.from} → ${scraperResult.flightData.to} (${scraperResult.flightData.flight_date})`);
        
        // PASO 2: Ejecutar Evaluador de Precios
        console.log('\n🔄 PASO 2: Ejecutando Evaluador de Precios...');
        console.log('=============================================\n');
        
        const evaluatorResult = await runPriceEvaluator(scraperResult.flightData.flight_date);
        
        if (evaluatorResult) {
            console.log('\n✅ Evaluador de Precios completado exitosamente');
            
            // PASO 3: Mostrar Resumen Final
            console.log('\n🔄 PASO 3: Generando Resumen Final...');
            console.log('====================================');
            
            await getHistoricalSummary();
            await getNotificationsHistory(5);
            
            // Resumen de la ejecución completa
            console.log('\n🎉 EJECUCIÓN COMPLETADA EXITOSAMENTE');
            console.log('===================================');
            console.log('📊 ESTADÍSTICAS FINALES:');
            console.log(`   • Web Scraper: ✅ ${scraperResult.job.origin_city} → ${scraperResult.job.destination_city}`);
            console.log(`   • Rutas analizadas: ${evaluatorResult.routesAnalyzed}`);
            console.log(`   • Alertas enviadas: ${evaluatorResult.alertsSent}`);
            
            if (evaluatorResult.alertsSent > 0) {
                console.log('\n🚨 ALERTAS ENVIADAS:');
                evaluatorResult.alerts.forEach(alert => {
                    console.log(`   • ${alert.route}: ${alert.currency}$${alert.price} (${alert.reason})`);
                });
            } else {
                console.log('\n📝 No se enviaron alertas en esta ejecución');
            }
            
        } else {
            console.log('\n❌ Evaluador de Precios falló');
        }
        
    } catch (error) {
        console.error('\n❌ ERROR CRÍTICO EN FUNCIÓN PRINCIPAL:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Ejecutar el sistema
main();