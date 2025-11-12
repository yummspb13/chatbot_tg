/**
 * Геокодинг для получения координат места проведения мероприятия
 */

export interface Coordinates {
  lat: number
  lng: number
}

/**
 * Получает координаты места через Yandex Maps Geocoding API
 * @param venue Название или адрес места
 * @param cityName Название города
 * @returns Координаты или null, если не найдено или API ключ не установлен
 */
export async function geocodeVenue(
  venue: string,
  cityName: string
): Promise<Coordinates | null> {
  const apiKey = process.env.YANDEX_MAPS_API_KEY

  if (!apiKey) {
    console.log('   📍 YANDEX_MAPS_API_KEY не установлен, пропускаю геокодинг')
    return null
  }

  if (!venue || !cityName) {
    console.log('   📍 Недостаточно данных для геокодинга (venue или cityName отсутствует)')
    return null
  }

  try {
    // Формируем запрос: город + место
    const query = `${cityName}, ${venue}`
    const encodedQuery = encodeURIComponent(query)
    const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${apiKey}&geocode=${encodedQuery}&format=json&results=1`

    console.log(`   📍 Геокодинг: "${query}"`)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      console.warn(`   ⚠️ Ошибка геокодинга: HTTP ${response.status}`)
      return null
    }

    const data = await response.json()

    // Проверяем структуру ответа Yandex Maps API
    if (
      data.response &&
      data.response.GeoObjectCollection &&
      data.response.GeoObjectCollection.featureMember &&
      data.response.GeoObjectCollection.featureMember.length > 0
    ) {
      const firstResult = data.response.GeoObjectCollection.featureMember[0]
      const geoObject = firstResult.GeoObject
      const pos = geoObject.Point?.pos

      if (pos) {
        // Yandex возвращает координаты в формате "lng lat" (долгота, широта)
        const [lng, lat] = pos.split(' ').map(Number)

        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
          console.log(`   📍 ✅ Координаты найдены: ${lat}, ${lng}`)
          return { lat, lng }
        }
      }
    }

    console.log('   📍 Координаты не найдены в ответе API')
    return null
  } catch (error: any) {
    console.warn(`   ⚠️ Ошибка геокодинга: ${error.message}`)
    return null
  }
}

