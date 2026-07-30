/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#import <UIKit/UIKit.h>

#include "CommunityHarrierRuntime.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <exception>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr double kRequiredMinimumCosine = 0.98;

double elapsed_milliseconds(
    const std::chrono::steady_clock::time_point& start) {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now() - start)
      .count();
}

NSDictionary* read_json_resource(NSString* name, NSError** error) {
  NSString* path = [NSBundle.mainBundle pathForResource:name ofType:@"json"];
  if (path == nil) {
    if (error != nullptr) {
      *error = [NSError
          errorWithDomain:@"TEX8HarrierDiagnostic"
                     code:1
                 userInfo:@{
                   NSLocalizedDescriptionKey :
                       [NSString stringWithFormat:@"missing %@.json", name]
                 }];
    }
    return nil;
  }
  NSData* data = [NSData dataWithContentsOfFile:path options:0 error:error];
  if (data == nil) {
    return nil;
  }
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  if (![value isKindOfClass:NSDictionary.class]) {
    if (error != nullptr && *error == nil) {
      *error = [NSError
          errorWithDomain:@"TEX8HarrierDiagnostic"
                     code:2
                 userInfo:@{
                   NSLocalizedDescriptionKey : @"invalid diagnostic JSON"
                 }];
    }
    return nil;
  }
  return (NSDictionary*)value;
}

std::vector<double> vector_from_json(NSArray* values) {
  std::vector<double> result;
  result.reserve(values.count);
  for (id value in values) {
    if (![value isKindOfClass:NSNumber.class]) {
      return {};
    }
    result.push_back([(NSNumber*)value doubleValue]);
  }
  return result;
}

double cosine_similarity(const std::vector<float>& candidate,
                         const std::vector<double>& reference) {
  if (candidate.size() != reference.size() || candidate.empty()) {
    return -1.0;
  }
  double dot = 0.0;
  double candidate_norm = 0.0;
  double reference_norm = 0.0;
  for (std::size_t index = 0; index < candidate.size(); ++index) {
    const double lhs = candidate[index];
    const double rhs = reference[index];
    dot += lhs * rhs;
    candidate_norm += lhs * lhs;
    reference_norm += rhs * rhs;
  }
  if (candidate_norm <= 0.0 || reference_norm <= 0.0) {
    return -1.0;
  }
  return dot / std::sqrt(candidate_norm * reference_norm);
}

NSString* diagnostic_summary() {
  @autoreleasepool {
    const auto total_start = std::chrono::steady_clock::now();
    NSLog(@"TEX8_HARRIER_DIAGNOSTIC event=start target=%s pte_sha256=%s "
          "privacy=canned-inputs-only",
          TEX8_HARRIER_DIAGNOSTIC_TARGET,
          TEX8_HARRIER_DIAGNOSTIC_PTE_SHA256);

    NSError* json_error = nil;
    NSDictionary* prepared =
        read_json_resource(@"prepared_inputs.v2", &json_error);
    NSDictionary* reference =
        read_json_resource(@"reference_vectors.v2", &json_error);
    if (prepared == nil || reference == nil) {
      throw std::runtime_error(
          json_error.localizedDescription.UTF8String ?: "JSON load failed");
    }
    NSArray* cases = prepared[@"cases"];
    NSArray* vectors = reference[@"vectors"];
    if (![cases isKindOfClass:NSArray.class] ||
        ![vectors isKindOfClass:NSArray.class] || cases.count < 32) {
      throw std::runtime_error("frozen conformance cases are invalid");
    }

    std::unordered_map<std::string, std::vector<double>> references;
    for (NSDictionary* item in vectors) {
      if (![item isKindOfClass:NSDictionary.class]) {
        throw std::runtime_error("reference vector item is invalid");
      }
      NSString* case_id = item[@"id"];
      NSArray* embedding = item[@"embedding"];
      if (![case_id isKindOfClass:NSString.class] ||
          ![embedding isKindOfClass:NSArray.class]) {
        throw std::runtime_error("reference vector contract is invalid");
      }
      references.emplace(
          case_id.UTF8String, vector_from_json(embedding));
    }

    NSString* pte_path =
        [NSBundle.mainBundle pathForResource:@"harrier-v1" ofType:@"pte"];
    NSString* tokenizer_path =
        [NSBundle.mainBundle pathForResource:@"tokenizer" ofType:@"json"];
    if (pte_path == nil || tokenizer_path == nil) {
      throw std::runtime_error("bundled model assets are missing");
    }

    tex8::community::CommunityHarrierRuntime runtime;
    std::string runtime_error;
    const auto load_start = std::chrono::steady_clock::now();
    if (!runtime.load(
            pte_path.UTF8String, tokenizer_path.UTF8String, runtime_error)) {
      throw std::runtime_error(runtime_error);
    }
    const double load_ms = elapsed_milliseconds(load_start);
    NSLog(@"TEX8_HARRIER_DIAGNOSTIC event=model_loaded target=%s load_ms=%.3f",
          TEX8_HARRIER_DIAGNOSTIC_TARGET,
          load_ms);

    double minimum_cosine = std::numeric_limits<double>::infinity();
    double inference_ms = 0.0;
    NSUInteger completed = 0;
    for (NSDictionary* item in cases) {
      NSString* case_id = item[@"id"];
      NSString* prepared_text = item[@"preparedText"];
      NSArray* expected_ids = item[@"inputIds"];
      if (![case_id isKindOfClass:NSString.class] ||
          ![prepared_text isKindOfClass:NSString.class] ||
          ![expected_ids isKindOfClass:NSArray.class]) {
        throw std::runtime_error("prepared input contract is invalid");
      }

      tex8::community::HarrierTokens tokens;
      if (!runtime.tokenize_prepared(
              prepared_text.UTF8String, tokens, runtime_error)) {
        throw std::runtime_error(runtime_error);
      }
      if (tokens.unpadded_tokens != expected_ids.count) {
        throw std::runtime_error("native tokenizer length differs");
      }
      for (NSUInteger index = 0; index < expected_ids.count; ++index) {
        if (tokens.input_ids[index] != [expected_ids[index] longLongValue]) {
          throw std::runtime_error("native tokenizer IDs differ");
        }
      }

      const auto reference_item = references.find(case_id.UTF8String);
      if (reference_item == references.end() ||
          reference_item->second.size() !=
              tex8::community::kHarrierEmbeddingDimension) {
        throw std::runtime_error("matching reference vector is missing");
      }
      std::vector<float> embedding;
      const auto inference_start = std::chrono::steady_clock::now();
      if (!runtime.embed_prepared(
              prepared_text.UTF8String, embedding, runtime_error)) {
        throw std::runtime_error(runtime_error);
      }
      const double case_ms = elapsed_milliseconds(inference_start);
      inference_ms += case_ms;
      const double cosine =
          cosine_similarity(embedding, reference_item->second);
      if (!std::isfinite(cosine)) {
        throw std::runtime_error("cosine result is invalid");
      }
      minimum_cosine = std::min(minimum_cosine, cosine);
      ++completed;
      NSLog(@"TEX8_HARRIER_DIAGNOSTIC event=case_complete target=%s "
            "case_id=%@ duration_ms=%.3f cosine=%.6f",
            TEX8_HARRIER_DIAGNOSTIC_TARGET,
            case_id,
            case_ms,
            cosine);
    }

    const bool accepted = minimum_cosine >= kRequiredMinimumCosine;
    const double total_ms = elapsed_milliseconds(total_start);
    const double average_ms =
        completed == 0 ? 0.0 : inference_ms / static_cast<double>(completed);
    NSLog(@"TEX8_HARRIER_DIAGNOSTIC event=complete target=%s cases=%lu "
          "minimum_cosine=%.6f required_cosine=%.6f status=%s load_ms=%.3f "
          "average_inference_ms=%.3f total_ms=%.3f",
          TEX8_HARRIER_DIAGNOSTIC_TARGET,
          static_cast<unsigned long>(completed),
          minimum_cosine,
          kRequiredMinimumCosine,
          accepted ? "accepted" : "rejected",
          load_ms,
          average_ms,
          total_ms);
    return [NSString
        stringWithFormat:
            @"Target: %s\nCases: %lu\nMinimum cosine: %.6f\n"
             "Required: %.6f\nResult: %s\nAverage: %.1f ms",
            TEX8_HARRIER_DIAGNOSTIC_TARGET,
            static_cast<unsigned long>(completed),
            minimum_cosine,
            kRequiredMinimumCosine,
            accepted ? "accepted" : "rejected",
            average_ms];
  }
}

}  // namespace

@interface TEX8HarrierDiagnosticViewController : UIViewController
@property(nonatomic, strong) UILabel* statusLabel;
@end

@implementation TEX8HarrierDiagnosticViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  UILabel* label = [[UILabel alloc] initWithFrame:CGRectZero];
  label.translatesAutoresizingMaskIntoConstraints = NO;
  label.numberOfLines = 0;
  label.font = [UIFont monospacedSystemFontOfSize:15
                                          weight:UIFontWeightRegular];
  label.text = @"Running isolated Harrier diagnostic…";
  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor
                                        constant:24],
    [label.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor
                                         constant:-24],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];
  self.statusLabel = label;

  __weak TEX8HarrierDiagnosticViewController* weak_self = self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString* summary = nil;
    try {
      summary = diagnostic_summary();
    } catch (const std::exception& exception) {
      NSLog(@"TEX8_HARRIER_DIAGNOSTIC event=failure target=%s reason=%s",
            TEX8_HARRIER_DIAGNOSTIC_TARGET,
            exception.what());
      summary = [NSString
          stringWithFormat:@"Diagnostic failed\n%s", exception.what()];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      weak_self.statusLabel.text = summary;
    });
  });
}

@end

@interface TEX8HarrierDiagnosticAppDelegate : UIResponder
    <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow* window;
@end

@implementation TEX8HarrierDiagnosticAppDelegate

- (BOOL)application:(UIApplication*)application
    didFinishLaunchingWithOptions:(NSDictionary*)launchOptions {
  (void)application;
  (void)launchOptions;
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController =
      [[TEX8HarrierDiagnosticViewController alloc] init];
  [self.window makeKeyAndVisible];
  return YES;
}

@end

int main(int argc, char* argv[]) {
  @autoreleasepool {
    return UIApplicationMain(
        argc,
        argv,
        nil,
        NSStringFromClass(TEX8HarrierDiagnosticAppDelegate.class));
  }
}
