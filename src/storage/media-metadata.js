export function extractMediaMetadata(message, fileCode) {
  let media;
  let fileType;
  let fallbackExtension;

  if (message.video) {
    media = message.video;
    fileType = 'video';
    fallbackExtension = '.mp4';
  } else if (message.document) {
    media = message.document;
    fileType = 'document';
    fallbackExtension = '';
  } else if (message.photo?.length) {
    media = message.photo.at(-1);
    fileType = 'photo';
    fallbackExtension = '.jpg';
  } else if (message.audio) {
    media = message.audio;
    fileType = 'audio';
    fallbackExtension = '';
  } else if (message.voice) {
    media = message.voice;
    fileType = 'voice';
    fallbackExtension = '.ogg';
  } else if (message.video_note) {
    media = message.video_note;
    fileType = 'video_note';
    fallbackExtension = '.mp4';
  } else if (message.animation) {
    media = message.animation;
    fileType = 'animation';
    fallbackExtension = '';
  } else {
    return null;
  }

  return {
    fileName: media.file_name?.trim() || `filestore_${fileCode}${fallbackExtension}`,
    fileType,
    mimeType: media.mime_type ?? null,
    fileSize: media.file_size ?? null,
    durationSeconds: media.duration ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    caption: message.caption ?? null,
    telegramFileId: media.file_id,
    telegramFileUniqueId: media.file_unique_id ?? null,
  };
}
