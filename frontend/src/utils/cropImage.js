/** Utilidades para generar un File recortado desde react-easy-crop. */

function createImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', (error) => reject(error))
    image.setAttribute('crossOrigin', 'anonymous')
    image.src = url
  })
}

function outputMimeType(sourceMime) {
  const m = String(sourceMime || '').split(';')[0].trim().toLowerCase()
  if (m === 'image/png' || m === 'image/webp' || m === 'image/jpeg') return m
  return 'image/jpeg'
}

function outputExtension(mime) {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  return '.jpg'
}

/**
 * @param {string} imageSrc Object URL o data URL de la imagen original.
 * @param {{ x: number, y: number, width: number, height: number }} pixelCrop
 * @param {string} [fileName]
 * @param {string} [sourceMime]
 * @returns {Promise<File>}
 */
export async function getCroppedImageFile(imageSrc, pixelCrop, fileName, sourceMime) {
  if (!pixelCrop?.width || !pixelCrop?.height) {
    throw new Error('Área de recorte inválida.')
  }

  const image = await createImage(imageSrc)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo de recorte.')

  canvas.width = Math.round(pixelCrop.width)
  canvas.height = Math.round(pixelCrop.height)

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height,
  )

  const mime = outputMimeType(sourceMime)
  const quality = mime === 'image/jpeg' ? 0.92 : undefined

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('No se pudo generar la imagen recortada.'))
          return
        }
        const base = String(fileName || 'imagen-recortada').replace(/\.[^.]+$/, '') || 'imagen-recortada'
        resolve(new File([blob], `${base}${outputExtension(mime)}`, { type: mime }))
      },
      mime,
      quality,
    )
  })
}
