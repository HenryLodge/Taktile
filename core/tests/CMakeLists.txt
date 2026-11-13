set(TK_TESTS
    test_util
    test_crypto
)

foreach(t ${TK_TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE tk_core)
    target_compile_options(${t} PRIVATE ${TK_WARNINGS})
    add_test(NAME ${t} COMMAND ${t})
endforeach()
