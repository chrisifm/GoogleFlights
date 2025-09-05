import { chromium } from 'playwright';
import { CONFIG, getContextConfig, getBrowserConfig } from './config.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Función para validar y formatear fecha de forma segura
function validateAndFormatDate(dateString) {
    try {
        if (!dateString) {
            throw new Error('Date is required');
        }
        
        // Validar formato YYYY-MM-DD
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateString)) {
            throw new Error(`Invalid date format. Expected YYYY-MM-DD, got: ${dateString}`);
        }
        
        // Crear fecha y validar que sea válida
        const date = new Date(dateString + 'T00:00:00.000Z'); // UTC para evitar problemas de timezone
        if (isNaN(date.getTime())) {
            throw new Error(`Invalid date: ${dateString}`);
        }
        
        // Formatear como DD/MM/YYYY para Google Flights
        const day = String(date.getUTCDate()).padStart(2, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const year = date.getUTCFullYear();
        
        return `${day}/${month}/${year}`;
    } catch (error) {
        console.error('❌ Error validating date:', error.message);
        throw new Error(`Cannot process flight date: ${error.message}`);
    }
}

// Función para validar datos de vuelo antes de guardar
function validateFlightData(flightData) {
    const errors = [];
    
    if (!flightData.from || typeof flightData.from !== 'string' || flightData.from.length < 1) {
        errors.push('Origin city is required and must be a non-empty string');
    }
    
    if (!flightData.to || typeof flightData.to !== 'string' || flightData.to.length < 1) {
        errors.push('Destination city is required and must be a non-empty string');
    }
    
    if (!flightData.price || typeof flightData.price !== 'number' || flightData.price <= 0) {
        errors.push('Price is required and must be a positive number');
    }
    
    if (flightData.price > 999999) {
        errors.push('Price seems unreasonably high (>999,999)');
    }
    
    if (!flightData.currency || !['MXN', 'USD', 'EUR'].includes(flightData.currency)) {
        errors.push('Currency must be MXN, USD, or EUR');
    }
    
    if (!flightData.flight_date) {
        errors.push('Flight date is required');
    }
    
    if (flightData.link && !flightData.link.startsWith('https://')) {
        errors.push('Link must be a valid HTTPS URL');
    }
    
    if (errors.length > 0) {
        throw new Error(`Flight data validation failed: ${errors.join(', ')}`);
    }
    
    return true;
}

// Función para resetear trabajos completed y processing a pending
async function resetJobsToPending() {
    try {
        console.log('🔄 Reseteando trabajos completados y procesando a pendiente...');
        
        let totalReset = 0;
        
        // Resetear trabajos completed
        const { data: completedData, error: completedError } = await supabase
            .from('config_flights')
            .update({ 
                status: 'pending',
                processing_instance_id: null,
                processing_started_at: null,
                updated_at: new Date().toISOString()
            })
            .eq('status', 'completed')
            .select();
        
        if (completedError) {
            console.error('❌ Error al resetear trabajos completed:', completedError.message);
        } else {
            const completedCount = completedData ? completedData.length : 0;
            if (completedCount > 0) {
                console.log(`✅ ${completedCount} trabajo(s) reseteado(s) de completed a pending`);
                completedData.forEach(job => {
                    console.log(`   • ${job.origin_city} → ${job.destination_city} (${job.flight_date})`);
                });
                totalReset += completedCount;
            }
        }
        
        // Resetear trabajos processing (posiblemente atascados)
        const { data: processingData, error: processingError } = await supabase
            .from('config_flights')
            .update({ 
                status: 'pending',
                processing_instance_id: null,
                processing_started_at: null,
                updated_at: new Date().toISOString()
            })
            .eq('status', 'processing')
            .select();
        
        if (processingError) {
            console.error('❌ Error al resetear trabajos processing:', processingError.message);
        } else {
            const processingCount = processingData ? processingData.length : 0;
            if (processingCount > 0) {
                console.log(`✅ ${processingCount} trabajo(s) reseteado(s) de processing a pending`);
                processingData.forEach(job => {
                    console.log(`   • ${job.origin_city} → ${job.destination_city} (${job.flight_date})`);
                });
                totalReset += processingCount;
            }
        }
        
        if (totalReset === 0) {
            console.log('📝 No hay trabajos para resetear');
        } else {
            console.log(`📊 Total de trabajos reseteados: ${totalReset}`);
        }
        
        return totalReset;
        
    } catch (error) {
        console.error('❌ Error crítico al resetear trabajos:', error.message);
        return 0;
    }
}

// Función para obtener y reclamar el próximo trabajo pendiente de forma atómica
async function getNextPendingJob() {
    try {
        console.log('🔍 Buscando y reclamando próximo trabajo pendiente...');
        
        // Implementar atomic job claiming con FOR UPDATE SKIP LOCKED
        const { data, error } = await supabase.rpc('claim_next_pending_job', {
            p_instance_id: `${process.pid}-${Date.now()}`
        });

        if (error) {
            console.error('❌ Error al reclamar trabajo:', error.message);
            return null;
        }

        if (!data || data.length === 0) {
            console.log('📭 No hay trabajos pendientes en este momento');
            
            // Resetear trabajos completed y processing a pending
            const resetCount = await resetJobsToPending();
            
            if (resetCount > 0) {
                console.log('🔄 Intentando reclamar uno de los trabajos reseteados...');
                // Intentar reclamar uno de los trabajos recién reseteados
                const { data: retryData, error: retryError } = await supabase.rpc('claim_next_pending_job', {
                    p_instance_id: `${process.pid}-${Date.now()}`
                });
                
                if (!retryError && retryData && retryData.length > 0) {
                    const job = retryData[0];
                    console.log(`✅ Trabajo reclamado después del reset: ${job.origin_city} → ${job.destination_city} (${job.flight_date})`);
                    console.log(`🆔 Instance ID: ${job.processing_instance_id}`);
                    return job;
                }
            }
            
            return null;
        }

        const job = data[0];
        console.log(`✅ Trabajo reclamado atomicamente: ${job.origin_city} → ${job.destination_city} (${job.flight_date})`);
        console.log(`🆔 Instance ID: ${job.processing_instance_id}`);
        return job;
        
    } catch (error) {
        console.error('❌ Error crítico al obtener trabajo:', error.message);
        return null;
    }
}

// Función para actualizar el estado del trabajo
async function updateJobStatus(jobId, status, attempts = null) {
    try {
        const updateData = { 
            status: status,
            updated_at: new Date().toISOString()
        };
        
        if (attempts !== null) {
            updateData.attempts = attempts;
        }

        const { error } = await supabase
            .from('config_flights')
            .update(updateData)
            .eq('id', jobId);

        if (error) {
            console.error('❌ Error actualizando estado del trabajo:', error.message);
            return false;
        }

        console.log(`📝 Estado actualizado: ${status}${attempts !== null ? ` (intentos: ${attempts})` : ''}`);
        return true;
        
    } catch (error) {
        console.error('❌ Error crítico actualizando estado:', error.message);
        return false;
    }
}

// Función para guardar precio en Supabase
async function savePriceToSupabase(flightData) {
    try {
        console.log('💾 Guardando precio en Supabase...');
        console.log(`   ${flightData.from} → ${flightData.to}: ${flightData.currency} $${flightData.price}`);
        
        // Validar datos antes de guardar
        validateFlightData(flightData);
        
        const payload = {
            updated_at: new Date().toISOString(),
            from: flightData.from,
            to: flightData.to,
            price: flightData.price,
            currency: flightData.currency,
            link: flightData.link,
            flight_date: flightData.flight_date
        };

        const { data, error } = await supabase
            .from('flights')
            .insert([payload]);

        if (error) {
            console.error('❌ Error al insertar en Supabase:', error.message);
            return false;
        }

        console.log('✅ Precio guardado exitosamente en tabla flights');
        return true;
        
    } catch (error) {
        console.error('❌ Error crítico al guardar en Supabase:', error.message);
        return false;
    }
}

// Función principal de scraping
async function scrapeFlight(job) {
    const browser = await chromium.launch(getBrowserConfig());
    const context = await browser.newContext(getContextConfig());
    const page = await context.newPage();
    let success = false;

    try {
        console.log(`🎭 Iniciando scraping para: ${job.origin_city} → ${job.destination_city}`);
        console.log(`📅 Fecha: ${job.flight_date}`);
        console.log(`🎯 Prioridad: ${job.priority} | Intentos previos: ${job.attempts}`);

        // 1. Navegación
        console.log('1. Navegando a Google Flights...');
        await page.goto(CONFIG.GOOGLE_FLIGHTS_URL);
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY * 2);

        // 2. Configurar origen
        console.log(`2. Configurando origen: ${job.origin_city}...`);
        await page.getByRole('combobox', { name: '¿Desde dónde?' }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        
        // 3. Solo ida
        console.log('3. Seleccionando "Solo ida"...');
        await page.locator('.VfPpkd-aPP78e').first().click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        await page.getByRole('option', { name: 'Solo ida' }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);

        // 4. Completar origen
        console.log(`4. Escribiendo origen: ${job.origin_city}...`);
        await page.getByRole('combobox', { name: '¿Desde dónde?' }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        
        let originSearchTerm = 'argentina';  // Para Buenos Aires, Argentina
        
        await page.getByRole('combobox', { name: '¿Desde dónde?' }).fill(originSearchTerm);
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        
        // Lógica de fallback: intentar primer elemento, luego segundo si es necesario
        let originSelected = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`   Intentando seleccionar origen (opción ${attempt})...`);
                
                // Navegar a la opción correcta
                for (let i = 0; i < attempt; i++) {
                    await page.getByRole('combobox', { name: '¿Desde dónde?' }).press('ArrowDown');
                    await page.waitForTimeout(300);
                }
                
                await page.getByRole('combobox', { name: '¿Desde dónde?' }).press('Enter');
                await page.waitForTimeout(500);
                
                // Verificar si se seleccionó correctamente
                const currentValue = await page.getByRole('combobox', { name: '¿Desde dónde?' }).inputValue();
                if (currentValue && currentValue.toLowerCase().includes('buenos aires')) {
                    console.log(`✅ Origen seleccionado exitosamente: ${currentValue}`);
                    originSelected = true;
                    break;
                }
            } catch (e) {
                console.log(`   Opción ${attempt} falló: ${e.message}`);
            }
        }
        
        if (!originSelected) {
            throw new Error('No se pudo seleccionar origen después de 2 intentos');
        }
        
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);

        // 5. Configurar destino
        console.log(`5. Configurando destino: ${job.destination_city}...`);
        await page.getByRole('combobox', { name: '¿A dónde quieres ir?' }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        
        let destSearchTerm = job.destination_city;
        
        await page.getByRole('combobox', { name: '¿A dónde quieres ir?' }).fill(destSearchTerm);
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        
        // Lógica de fallback: intentar primer elemento, luego segundo si es necesario
        let destinationSelected = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`   Intentando seleccionar destino (opción ${attempt})...`);
                
                // Navegar a la opción correcta
                for (let i = 0; i < attempt; i++) {
                    await page.getByRole('combobox', { name: '¿A dónde quieres ir?' }).press('ArrowDown');
                    await page.waitForTimeout(300);
                }
                
                await page.getByRole('combobox', { name: '¿A dónde quieres ir?' }).press('Enter');
                await page.waitForTimeout(500);
                
                // Verificar si se seleccionó correctamente
                const currentValue = await page.getByRole('combobox', { name: '¿A dónde quieres ir?' }).inputValue();
                if (currentValue && currentValue.length > 3 && 
                    (currentValue.toLowerCase().includes(destSearchTerm.toLowerCase()) || 
                     destSearchTerm.toLowerCase().includes(currentValue.toLowerCase().split(',')[0]))) {
                    console.log(`✅ Destino seleccionado exitosamente: ${currentValue}`);
                    destinationSelected = true;
                    break;
                } else {
                    console.log(`   Valor actual: "${currentValue}", esperado que contenga: "${destSearchTerm}"`);
                }
            } catch (e) {
                console.log(`   Opción ${attempt} falló: ${e.message}`);
            }
        }
        
        if (!destinationSelected) {
            console.log('⚠️ No se pudo verificar destino, pero continuando...');
            const finalValue = await page.getByRole('combobox', { name: '¿A dónde quieres ir?' }).inputValue();
            console.log(`   Valor final en campo destino: "${finalValue}"`);
        }
        
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);

        // 6. Configurar fecha
        console.log(`6. Configurando fecha: ${job.flight_date}...`);
        await page.getByRole('textbox', { name: 'Salida' }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        
        // Validar y formatear fecha de forma segura
        const formattedDate = validateAndFormatDate(job.flight_date);
        console.log(`   Fecha convertida: ${job.flight_date} → ${formattedDate}`);
        
        await page.getByRole('textbox', { name: 'Salida' }).fill(formattedDate);
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);
        await page.getByRole('textbox', { name: 'Salida' }).press('Enter');
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);

        // 7. Confirmar y buscar
        console.log('7. Confirmando búsqueda...');
        await page.getByRole('button', { name: 'Listo. Buscar vuelos de ida' }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);

        console.log('8. Iniciando búsqueda...');
        await page.getByRole('button', { name: 'Buscar', exact: true }).click();
        await page.waitForTimeout(CONFIG.SEARCH.CLICK_DELAY);

        console.log('9. Esperando resultados...');
        await page.waitForTimeout(CONFIG.SEARCH.PRICE_SEARCH_INTERVAL * 5);

        // 10. Buscar y capturar precio
        console.log('10. Buscando precios...\n');
        
        let priceFound = false;
        let attempts = 0;
        const maxAttempts = CONFIG.SEARCH.MAX_PRICE_SEARCH_ATTEMPTS;
        
        while (!priceFound && attempts < maxAttempts) {
            attempts++;
            console.log(`   Intento ${attempts}/${maxAttempts}...`);
            
            try {
                // Buscar el tab "Más económicos"
                const cheapestTab = await page.getByRole('tab', { name: /Más económicos desde \d+/i });
                if (await cheapestTab.isVisible()) {
                    console.log('✅ Tab "Más económicos" encontrado');
                    
                    // Capturar el precio
                    const tabText = await cheapestTab.textContent();
                    const priceMatch = tabText.match(/(\d+[\d,]*)/);
                    
                    if (priceMatch) {
                        const capturedPrice = parseInt(priceMatch[1].replace(/,/g, ''));
                        console.log(`💰 Precio capturado: ${capturedPrice} MXN`);
                        
                        // Hacer click en el precio
                        await cheapestTab.getByLabel('pesos mexicanos').click();
                        console.log('✅ Click en precio realizado exitosamente!');
                        
                        // Guardar en Supabase
                        await savePriceToSupabase({
                            from: job.origin_city,
                            to: job.destination_city,
                            price: capturedPrice,
                            currency: 'MXN',
                            link: page.url(),
                            flight_date: job.flight_date
                        });
                        
                        priceFound = true;
                        success = true;
                        break;
                    }
                }
            } catch (e) {
                console.log(`   Tab específico no encontrado, intentando estrategia alternativa...`);
            }
            
            if (!priceFound) {
                console.log(`   ⏳ Esperando más resultados... (${attempts}/${maxAttempts})`);
                await page.waitForTimeout(CONFIG.SEARCH.PRICE_SEARCH_INTERVAL);
            }
        }
        
        if (priceFound) {
            console.log('\n✅ ¡PRECIO ENCONTRADO Y GUARDADO EXITOSAMENTE!');
        } else {
            console.log('\n⚠️ No se pudieron encontrar precios después de múltiples intentos');
        }
        
    } catch (error) {
        console.error('\n❌ Error durante la ejecución:', error.message);
        success = false;
        
    } finally {
        await browser.close();
        return success;
    }
}

// Función principal del web scraper
export async function runWebScraper() {
    console.log('🚀 Iniciando Web Scraper');
    console.log('======================\n');
    
    try {
        // 1. Obtener próximo trabajo
        const job = await getNextPendingJob();
        if (!job) {
            console.log('🎉 No hay trabajos pendientes.');
            return null;
        }
        
        // 2. Marcar como processing
        console.log(`🔄 Marcando trabajo ${job.id} como "processing"...`);
        await updateJobStatus(job.id, 'processing');
        
        // 3. Ejecutar scraping
        const success = await scrapeFlight(job);
        
        // 4. Actualizar estado final
        if (success) {
            console.log('✅ Trabajo completado exitosamente');
            // Incrementar iterations cuando se completa exitosamente
            const newIterations = (job.iterations || 0) + 1;
            const updateData = { 
                status: 'completed',
                iterations: newIterations,
                updated_at: new Date().toISOString()
            };
            
            const { error } = await supabase
                .from('config_flights')
                .update(updateData)
                .eq('id', job.id);
                
            if (error) {
                console.error('❌ Error actualizando estado completado:', error.message);
            } else {
                console.log(`📝 Estado actualizado: completed (iterations: ${newIterations})`);
            }
        } else {
            console.log('❌ Trabajo falló');
            const newAttempts = job.attempts + 1;
            await updateJobStatus(job.id, 'failed', newAttempts);
            
            // Si menos de 3 intentos, volver a pending para retry
            if (newAttempts < 3) {
                console.log(`🔄 Reintentará más tarde (intento ${newAttempts}/3)`);
                setTimeout(async () => {
                    await updateJobStatus(job.id, 'pending', newAttempts);
                }, 1000);
            } else {
                console.log(`❌ Trabajo marcado como fallido después de 3 intentos`);
            }
        }
        
        console.log('\n📊 RESUMEN FINAL:');
        console.log(`   - Trabajo ID: ${job.id}`);
        console.log(`   - Ruta: ${job.origin_city} → ${job.destination_city}`);
        console.log(`   - Fecha: ${job.flight_date}`);
        console.log(`   - Estado final: ${success ? 'completed' : 'failed'}`);
        console.log(`   - Intentos: ${success ? job.attempts : job.attempts + 1}`);
        
        return {
            success,
            job,
            flightData: success ? {
                from: job.origin_city,
                to: job.destination_city,
                flight_date: job.flight_date
            } : null
        };
        
    } catch (error) {
        console.error('❌ Error crítico en web scraper:', error.message);
        return null;
    }
}