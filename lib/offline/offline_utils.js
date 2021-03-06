/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.offline.OfflineUtils');

goog.require('goog.asserts');
goog.require('shaka.media.InitSegmentReference');
goog.require('shaka.media.PresentationTimeline');
goog.require('shaka.media.SegmentIndex');
goog.require('shaka.media.SegmentReference');
goog.require('shaka.util.StreamUtils');


/** @const {!Object.<string, string>} */
shaka.offline.OfflineUtils.DB_SCHEME = {'manifest': 'key', 'segment': 'key'};


/**
 * Converts the given database manifest to a storedContent structure.
 *
 * @param {shakaExtern.ManifestDB} manifest
 * @return {shakaExtern.StoredContent}
 */
shaka.offline.OfflineUtils.getStoredContent = function(manifest) {
  goog.asserts.assert(manifest.periods.length > 0,
                      'Must be at least one Period.');

  // Reconstruct the first period to get the variants
  var timeline = new shaka.media.PresentationTimeline(null, 0);
  var period = shaka.offline.OfflineUtils.reconstructPeriod(
      manifest.periods[0], [], timeline);

  var tracks = shaka.util.StreamUtils.getTracks(period, {});

  return {
    offlineUri: 'offline:' + manifest.key,
    originalManifestUri: manifest.originalManifestUri,
    duration: manifest.duration,
    size: manifest.size,
    tracks: tracks,
    appMetadata: manifest.appMetadata
  };
};


/**
 * Reconstructs a period object from the given database period.
 *
 * @param {shakaExtern.PeriodDB} period
 * @param {!Array.<shakaExtern.DrmInfo>} drmInfos
 * @param {shaka.media.PresentationTimeline} timeline
 * @return {shakaExtern.Period}
 */
shaka.offline.OfflineUtils.reconstructPeriod = function(
    period, drmInfos, timeline) {
  var OfflineUtils = shaka.offline.OfflineUtils;
  var textStreamsDb = period.streams.filter(function(streamDb) {
    return streamDb.contentType == 'text';
  });

  var audioStreamsDb = period.streams.filter(function(streamDb) {
    return streamDb.contentType == 'audio';
  });

  var videoStreamsDb = period.streams.filter(function(streamDb) {
    return streamDb.contentType == 'video';
  });

  var variants = OfflineUtils.createVariants_(
      audioStreamsDb,
      videoStreamsDb,
      drmInfos);
  var textStreams = textStreamsDb.map(OfflineUtils.createStream_);

  period.streams.forEach(function(streamDb) {
    var refs = OfflineUtils.getSegmentReferences_(streamDb);
    timeline.notifySegments(period.startTime, refs);
  });

  return {
    startTime: period.startTime,
    variants: variants,
    textStreams: textStreams
  };
};


/**
 * @param {!shakaExtern.StreamDB} streamDb
 * @return {!Array.<!shaka.media.SegmentReference>}
 * @private
 */
shaka.offline.OfflineUtils.getSegmentReferences_ = function(streamDb) {
  return streamDb.segments.map(function(segment, i) {
    var getUris = function() { return [segment.uri]; };
    return new shaka.media.SegmentReference(
        i, segment.startTime, segment.endTime, getUris, 0, null);
  });
};


/**
 * Creates Variants from audio and video StreamDB collections.
 *
 * @param {!Array.<!shakaExtern.StreamDB>} audios
 * @param {!Array.<!shakaExtern.StreamDB>} videos
 * @param {!Array.<!shakaExtern.DrmInfo>} drmInfos
 * @return {!Array.<!shakaExtern.Variant>}
 * @private
 */
shaka.offline.OfflineUtils.createVariants_ = function(
    audios, videos, drmInfos) {
  var variants = [];
  if (!audios.length && !videos.length) return variants;

  var OfflineUtils = shaka.offline.OfflineUtils;
  var id = 0;
  if (audios.length && videos.length) {
    for (var i = 0; i < audios.length; i++) {
      for (var j = 0; j < videos.length; j++) {
        if (OfflineUtils.areCompatible_(audios[i], videos[j])) {
          var variant = OfflineUtils.createVariant_(
              audios[i],
              videos[j],
              drmInfos,
              id++);
          variants.push(variant);
        }
      }
    }
  } else {
    // Audio or video only
    var streamsDB = audios.length ? audios : videos;
    for (var i = 0; i < streamsDB.length; i++) {
      var variant = OfflineUtils.createVariant_(
          audios.length ? audios[i] : null,
          videos.length ? videos[i] : null,
          drmInfos,
          id++);
      variants.push(variant);
    }
  }

  return variants;
};


/**
 * Checks if two streams can be combined into a variant.
 *
 * @param {!shakaExtern.StreamDB} stream1
 * @param {!shakaExtern.StreamDB} stream2
 * @return {boolean}
 * @private
 */
shaka.offline.OfflineUtils.areCompatible_ = function(stream1, stream2) {
  // Treat content that doesn't have variantIds as compatible
  // with anything for compatibility with content stored before
  // the variants were introduced.
  if (!stream1.variantIds || !stream2.variantIds)
    return true;

  for (var i = 0; i < stream1.variantIds.length; i++) {
    if (stream2.variantIds.some(function(id) {
      return id == stream1.variantIds[i];
    })) {
      return true;
    }
  }

  return false;
};


/**
 * Creates a Variant from an audio and a video StreamDBs.
 * If one of the streams is null, it creates a Variant from the other.
 *
 * @param {?shakaExtern.StreamDB} audio
 * @param {?shakaExtern.StreamDB} video
 * @param {!Array.<!shakaExtern.DrmInfo>} drmInfos
 * @param {number} id
 * @return {!shakaExtern.Variant}
 * @private
 */
shaka.offline.OfflineUtils.createVariant_ = function(
    audio, video, drmInfos, id) {
  var isPrimary = false;
  if ((audio && audio.primary) || (video && video.primary))
    isPrimary = true;

  return {
    id: id,
    language: audio ? audio.language : '',
    primary: isPrimary,
    audio: shaka.offline.OfflineUtils.createStream_(audio),
    video: shaka.offline.OfflineUtils.createStream_(video),
    bandwidth: 0,
    drmInfos: drmInfos,
    allowedByApplication: true,
    allowedByKeySystem: true
  };
};


/**
 * Creates a shakaExtern.Stream from a StreamDB.
 *
 * @param {?shakaExtern.StreamDB} streamDb
 * @return {?shakaExtern.Stream}
 * @private
 */
shaka.offline.OfflineUtils.createStream_ = function(streamDb) {
  if (!streamDb) return null;

  var refs =
      shaka.offline.OfflineUtils.getSegmentReferences_(streamDb);

  var segmentIndex = new shaka.media.SegmentIndex(refs);

  var initRef = streamDb.initSegmentUri ?
      new shaka.media.InitSegmentReference(
          function() { return [streamDb.initSegmentUri]; }, 0, null) :
      null;
  return {
    id: streamDb.id,
    createSegmentIndex: Promise.resolve.bind(Promise),
    findSegmentPosition: segmentIndex.find.bind(segmentIndex),
    getSegmentReference: segmentIndex.get.bind(segmentIndex),
    initSegmentReference: initRef,
    presentationTimeOffset: streamDb.presentationTimeOffset,
    mimeType: streamDb.mimeType,
    codecs: streamDb.codecs,
    width: streamDb.width || undefined,
    height: streamDb.height || undefined,
    frameRate: streamDb.frameRate || undefined,
    kind: streamDb.kind,
    encrypted: streamDb.encrypted,
    keyId: streamDb.keyId,
    language: streamDb.language,
    type: streamDb.contentType,
    primary: streamDb.primary,
    trickModeVideo: null
  };
};
