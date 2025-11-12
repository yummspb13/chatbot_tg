/**
 * Утилита для загрузки изображений в Cloudinary
 * Загружает только одобренные изображения (при нажатии "Принять")
 */

import { v2 as cloudinary } from 'cloudinary'

// Настройка Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dkbh2wihq',
  api_key: process.env.CLOUDINARY_API_KEY || '246521541339249',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'ps0PRzY_Mxex1Kfl0OutqaH-98o',
})

export interface UploadResult {
  url: string
  publicId: string
  width?: number
  height?: number
}

/**
 * Загружает изображение в Cloudinary из URL
 * @param imageUrl URL изображения (например, из Telegram)
 * @param folder Папка в Cloudinary (опционально)
 * @returns URL загруженного изображения в Cloudinary
 */
export async function uploadImageFromUrl(
  imageUrl: string,
  folder: string = 'afisha-bot'
): Promise<UploadResult> {
  console.log(`[Cloudinary] Загружаю изображение из URL: ${imageUrl.substring(0, 100)}...`)
  
  try {
    const result = await cloudinary.uploader.upload(imageUrl, {
      folder: `afisha-bot/${folder}`,
      resource_type: 'image',
      // Автоматическая оптимизация
      fetch_format: 'auto',
      quality: 'auto',
      // Сохраняем оригинальное имя (если есть)
      use_filename: true,
      unique_filename: true,
    })
    
    console.log(`[Cloudinary] ✅ Изображение загружено: ${result.secure_url.substring(0, 100)}...`)
    console.log(`[Cloudinary]    Public ID: ${result.public_id}`)
    console.log(`[Cloudinary]    Размер: ${result.width}x${result.height}`)
    
    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
    }
  } catch (error: any) {
    console.error(`[Cloudinary] ❌ Ошибка загрузки изображения:`, error.message)
    console.error(`[Cloudinary]    URL: ${imageUrl.substring(0, 100)}`)
    throw error
  }
}

/**
 * Загружает изображение в Cloudinary из Buffer
 * @param buffer Buffer изображения
 * @param folder Папка в Cloudinary (опционально)
 * @returns URL загруженного изображения в Cloudinary
 */
export async function uploadImageFromBuffer(
  buffer: Buffer,
  folder: string = 'afisha-bot'
): Promise<UploadResult> {
  console.log(`[Cloudinary] Загружаю изображение из Buffer (${buffer.length} bytes)`)
  
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `afisha-bot/${folder}`,
        resource_type: 'image',
        fetch_format: 'auto',
        quality: 'auto',
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) {
          console.error(`[Cloudinary] ❌ Ошибка загрузки из Buffer:`, error.message)
          reject(error)
        } else if (result) {
          console.log(`[Cloudinary] ✅ Изображение загружено: ${result.secure_url.substring(0, 100)}...`)
          console.log(`[Cloudinary]    Public ID: ${result.public_id}`)
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
          })
        } else {
          reject(new Error('Unknown error'))
        }
      }
    )
    
    uploadStream.end(buffer)
  })
}

/**
 * Загружает несколько изображений в Cloudinary
 * @param imageUrls Массив URL изображений
 * @param folder Папка в Cloudinary (опционально)
 * @returns Массив URL загруженных изображений
 */
export async function uploadMultipleImages(
  imageUrls: string[],
  folder: string = 'afisha-bot'
): Promise<UploadResult[]> {
  console.log(`[Cloudinary] Загружаю ${imageUrls.length} изображений...`)
  
  const results: UploadResult[] = []
  
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const result = await uploadImageFromUrl(imageUrls[i], folder)
      results.push(result)
      console.log(`[Cloudinary] ✅ Изображение ${i + 1}/${imageUrls.length} загружено`)
    } catch (error: any) {
      console.error(`[Cloudinary] ❌ Ошибка загрузки изображения ${i + 1}:`, error.message)
      // Продолжаем загрузку остальных изображений
    }
  }
  
  console.log(`[Cloudinary] ✅ Загружено ${results.length}/${imageUrls.length} изображений`)
  return results
}

