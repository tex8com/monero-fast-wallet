#pragma once

// Boost 1.90's generic is_unsigned implementation probes enum signedness by
// casting -1 to the enum. Clang 22 rejects that probe as a non-constant
// expression when the enum has a restricted value range. Use the enum's real
// underlying type instead. This preserves the intended signedness result and
// leaves Boost's global compiler feature configuration untouched.
#if defined(_WIN32) && defined(__clang__) && defined(__aarch64__)
#  if !defined(BOOST_TT_IS_UNSIGNED_HPP_INCLUDED)
#    include <boost/type_traits/integral_constant.hpp>
#    include <type_traits>
#    define BOOST_TT_IS_UNSIGNED_HPP_INCLUDED

namespace boost {
namespace tex8_detail {

template <class T, bool IsEnum = std::is_enum<typename std::remove_cv<T>::type>::value>
struct is_unsigned_impl
    : std::is_unsigned<typename std::remove_cv<T>::type> {};

template <class T>
struct is_unsigned_impl<T, true>
    : std::is_unsigned<typename std::underlying_type<
          typename std::remove_cv<T>::type>::type> {};

} // namespace tex8_detail

template <class T>
struct is_unsigned
    : integral_constant<bool, tex8_detail::is_unsigned_impl<T>::value> {};

} // namespace boost
#  endif
#endif
