import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Función para registrar notificación en la base de datos
async function logNotification(routeId, fromCity, toCity, flightDate, notificationType, oldPrice, newPrice, priceDrop, dropPercentage, currency, alertReason, pushcutResponse = null) {
    try {
        const notificationData = {
            route_id: routeId,
            from_city: fromCity,
            to_city: toCity,
            flight_date: flightDate,
            notification_type: notificationType,
            old_price: oldPrice,
            new_price: newPrice,
            price_drop: priceDrop,
            drop_percentage: dropPercentage,
            currency: currency,
            alert_reason: alertReason,
            pushcut_response: pushcutResponse,
            notification_sent_at: new Date().toISOString()
        };

        const { error } = await supabase
            .from('notifications')
            .insert([notificationData]);

        if (error) {
            console.error('❌ Error registrando notificación:', error.message);
            return false;
        }

        console.log('📝 Notificación registrada en base de datos');
        return true;
    } catch (error) {
        console.error('❌ Error crítico registrando notificación:', error.message);
        return false;
    }
}

// Función para verificar si se puede enviar notificación
async function canSendNotification(from, to, flightDate, newPrice) {
    try {
        // Buscar la última notificación para esta ruta
        const { data: lastNotification, error } = await supabase
            .from('notifications')
            .select('*')
            .eq('from_city', from)
            .eq('to_city', to)
            .eq('flight_date', flightDate)
            .order('notification_sent_at', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
            console.error('Error al buscar última notificación:', error.message);
            return true; // Por defecto, permitir envío si hay error
        }

        // Si no hay notificaciones previas, se puede enviar
        if (!lastNotification) {
            console.log('✅ Sin notificaciones previas para esta ruta');
            return true;
        }

        // Verificar tiempo transcurrido desde última notificación
        const lastSentTime = new Date(lastNotification.notification_sent_at);
        const currentTime = new Date();
        const hoursDiff = (currentTime - lastSentTime) / (1000 * 60 * 60);

        console.log(`⏰ Última notificación enviada hace ${Math.round(hoursDiff * 10) / 10} horas`);

        // Si han pasado menos de 12 horas
        if (hoursDiff < 12) {
            // Solo permitir si el precio es diferente al último enviado
            if (lastNotification.new_price === newPrice) {
                console.log(`❌ Bloqueo de notificación: Mismo precio ($${newPrice}) y menos de 12 horas (${Math.round(hoursDiff * 10) / 10}h)`);
                return false;
            } else {
                console.log(`✅ Precio diferente ($${lastNotification.new_price} → $${newPrice}), se permite envío`);
                return true;
            }
        }

        // Si han pasado más de 12 horas, siempre permitir
        console.log('✅ Han pasado más de 12 horas desde la última notificación');
        return true;

    } catch (error) {
        console.error('Error crítico en canSendNotification:', error.message);
        return true; // Por defecto, permitir envío si hay error
    }
}

// Función principal para enviar alerta de precio
export async function sendPriceAlert(from, to, currentPrice, currency, flightDate, reason = 'Precio bajo detectado', routeId = null, oldPrice = null, priceDrop = null) {
    try {
        // Verificar si se puede enviar notificación
        const canSend = await canSendNotification(from, to, flightDate, currentPrice);
        
        if (!canSend) {
            console.log('🔕 Notificación bloqueada por reglas de frecuencia');
            return false;
        }

        const response = await fetch(CONFIG.ALERTS.PUSHCUT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: `${reason}: ${currency}$${currentPrice} para ${flightDate}`,
                title: `Vuelo ${from} → ${to}`
            })
        });

        const responseData = await response.json().catch(() => null);
        const isSuccess = response.ok;

        if (isSuccess) {
            console.log('🚨 Alerta de precio enviada exitosamente');
        } else {
            console.error('Error al enviar alerta:', response.statusText);
        }

        // Registrar la notificación en la base de datos independientemente del resultado
        if (routeId) {
            const dropPercentage = oldPrice && oldPrice > 0 ? ((priceDrop / oldPrice) * 100) : 0;
            
            await logNotification(
                routeId,
                from,
                to,
                flightDate,
                'price_drop',
                oldPrice,
                currentPrice,
                priceDrop,
                Math.round(dropPercentage * 100) / 100, // Redondear a 2 decimales
                currency,
                reason,
                { 
                    success: isSuccess, 
                    status: response.status, 
                    response: responseData 
                }
            );
        }

        return isSuccess;
    } catch (error) {
        console.error('Error al enviar alerta:', error);
        
        // Registrar el error en la base de datos si tenemos routeId
        if (routeId) {
            const dropPercentage = oldPrice && oldPrice > 0 ? ((priceDrop / oldPrice) * 100) : 0;
            
            await logNotification(
                routeId,
                from,
                to,
                flightDate,
                'price_drop',
                oldPrice,
                currentPrice,
                priceDrop,
                Math.round(dropPercentage * 100) / 100,
                currency,
                reason,
                { 
                    success: false, 
                    error: error.message 
                }
            );
        }
        
        return false;
    }
}

// Función para obtener historial de notificaciones
export async function getNotificationsHistory(limit = 10) {
    try {
        const { data: notifications, error } = await supabase
            .from('notifications')
            .select('*')
            .order('notification_sent_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Error al obtener historial de notificaciones:', error.message);
            return null;
        }

        console.log('\n🔔 HISTORIAL DE NOTIFICACIONES:');
        console.log('==============================');
        
        if (notifications && notifications.length > 0) {
            notifications.forEach((notification, index) => {
                const dateTime = new Date(notification.notification_sent_at).toLocaleString('es-MX');
                const success = notification.pushcut_response?.success ? '✅' : '❌';
                
                console.log(`\n${index + 1}. ${success} ${notification.from_city} → ${notification.to_city}`);
                console.log(`   💰 Precio: ${notification.currency}$${notification.new_price} (bajó $${notification.price_drop})`);
                console.log(`   📉 Porcentaje: ${notification.drop_percentage}%`);
                console.log(`   📝 Razón: ${notification.alert_reason}`);
                console.log(`   🕐 Enviada: ${dateTime}`);
                
                if (notification.pushcut_response && !notification.pushcut_response.success) {
                    console.log(`   ❌ Error: ${notification.pushcut_response.error || 'Error desconocido'}`);
                }
            });
        } else {
            console.log('📭 No hay notificaciones registradas');
        }

        return notifications;
    } catch (error) {
        console.error('Error al obtener historial de notificaciones:', error.message);
        return null;
    }
}

// Función para obtener estadísticas de notificaciones
export async function getNotificationStats() {
    try {
        // Total de notificaciones
        const { count: totalCount, error: totalError } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true });

        if (totalError) {
            console.error('Error obteniendo total de notificaciones:', totalError.message);
            return null;
        }

        // Notificaciones exitosas
        const { count: successCount, error: successError } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('pushcut_response->success', true);

        if (successError) {
            console.error('Error obteniendo notificaciones exitosas:', successError.message);
            return null;
        }

        // Notificaciones de las últimas 24 horas
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: last24hCount, error: last24hError } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .gte('notification_sent_at', twentyFourHoursAgo);

        if (last24hError) {
            console.error('Error obteniendo notificaciones de últimas 24h:', last24hError.message);
            return null;
        }

        const stats = {
            total: totalCount || 0,
            successful: successCount || 0,
            failed: (totalCount || 0) - (successCount || 0),
            last24Hours: last24hCount || 0,
            successRate: totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(1) : 0
        };

        console.log('\n📊 ESTADÍSTICAS DE NOTIFICACIONES:');
        console.log('===================================');
        console.log(`   📨 Total enviadas: ${stats.total}`);
        console.log(`   ✅ Exitosas: ${stats.successful}`);
        console.log(`   ❌ Fallidas: ${stats.failed}`);
        console.log(`   ⏰ Últimas 24h: ${stats.last24Hours}`);
        console.log(`   📈 Tasa de éxito: ${stats.successRate}%`);

        return stats;
    } catch (error) {
        console.error('Error obteniendo estadísticas de notificaciones:', error.message);
        return null;
    }
}