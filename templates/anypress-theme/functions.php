<?php
/**
 * AnyPress theme setup.
 *
 * Presentation only: pattern categories and two block styles. Everything a store does
 * (bindings, abilities, site tools) lives in the WaaS Client plugin.
 *
 * @package AnyPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Pattern categories. Core categories are used where they fit; these group the
 * AnyPress sections so the inserter and the site tools can list them.
 */
function anypress_register_pattern_categories() {
	$categories = array(
		'anypress-heroes'   => array( __( 'Heroes', 'anypress' ), __( 'Opening sections that say what the business does and give one main action.', 'anypress' ) ),
		'anypress-proof'    => array( __( 'Proof', 'anypress' ), __( 'Reviews, results, logos and credentials that make visitors trust the business.', 'anypress' ) ),
		'anypress-details'  => array( __( 'Business details', 'anypress' ), __( 'Opening hours, location, areas served and contact details.', 'anypress' ) ),
	);
	foreach ( $categories as $slug => $category ) {
		register_block_pattern_category(
			$slug,
			array(
				'label'       => $category[0],
				'description' => $category[1],
			)
		);
	}
}
add_action( 'init', 'anypress_register_pattern_categories' );

/**
 * Block styles kept from the stores' previous theme, so pages built with it still render.
 */
function anypress_register_block_styles() {
	register_block_style(
		'core/cover',
		array(
			'name'         => 'blur-image-less',
			'label'        => __( 'Soft blur', 'anypress' ),
			'inline_style' => '.wp-block-cover.is-style-blur-image-less img.wp-block-cover__image-background{filter:blur(6px);transform:scale(1.04)}',
		)
	);
}
add_action( 'init', 'anypress_register_block_styles' );

/**
 * Stores show only this theme's patterns: no remote Pattern Directory calls.
 */
add_filter( 'should_load_remote_block_patterns', '__return_false' );

/**
 * Core's generic patterns are removed so the inserter and the site tools only offer
 * sections built from this theme's tokens.
 */
function anypress_setup() {
	remove_theme_support( 'core-block-patterns' );
}
add_action( 'after_setup_theme', 'anypress_setup' );

/**
 * Sections run edge to edge: no page-level gap above the footer, so the last section meets it.
 */
function anypress_enqueue_styles() {
	wp_register_style( 'anypress', false, array(), wp_get_theme()->get( 'Version' ) );
	wp_enqueue_style( 'anypress' );
	wp_add_inline_style( 'anypress', '.wp-site-blocks>footer{margin-block-start:0}' );
}
add_action( 'wp_enqueue_scripts', 'anypress_enqueue_styles' );
